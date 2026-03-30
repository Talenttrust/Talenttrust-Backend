import { AsyncLocalStorage } from 'node:async_hooks';

export type SpanKind = 'api' | 'db' | 'rpc';
export type SpanStatus = 'ok' | 'error';

export interface SpanRecord {
  traceId: string;
  requestId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  startedAt: string;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
  error?: string;
}

export interface SpanLogger {
  logSpan(span: SpanRecord): void;
}

interface TraceContext {
  traceId: string;
  requestId: string;
  activeSpanId?: string;
}

export interface Span {
  traceId: string;
  requestId: string;
  spanId: string;
  parentSpanId?: string;
  setAttribute(key: string, value: string | number | boolean): void;
  recordError(error: unknown): void;
  run<T>(callback: () => T): T;
  end(status?: SpanStatus): void;
}

const contextStore = new AsyncLocalStorage<TraceContext>();

const createId = (): string =>
  `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown error';
};

export class ConsoleSpanLogger implements SpanLogger {
  logSpan(span: SpanRecord): void {
    console.log(JSON.stringify({ type: 'trace.span', ...span }));
  }
}

export class InMemorySpanLogger implements SpanLogger {
  public readonly spans: SpanRecord[] = [];

  logSpan(span: SpanRecord): void {
    this.spans.push(span);
  }
}

export class Tracer {
  constructor(private readonly logger: SpanLogger = new ConsoleSpanLogger()) {}

  withContext<T>(traceId: string, requestId: string, callback: () => T): T {
    return contextStore.run({ traceId, requestId }, callback);
  }

  getCurrentContext(): TraceContext | undefined {
    return contextStore.getStore();
  }

  newTraceId(): string {
    return createId();
  }

  newRequestId(): string {
    return createId();
  }

  startSpan(
    name: string,
    kind: SpanKind,
    attributes: Record<string, string | number | boolean> = {},
  ): Span {
    const initialContext = contextStore.getStore();
    const traceId = initialContext?.traceId ?? this.newTraceId();
    const requestId = initialContext?.requestId ?? this.newRequestId();
    const spanId = createId();
    const parentSpanId = initialContext?.activeSpanId;
    const startedAt = new Date();
    let status: SpanStatus = 'ok';
    let error: string | undefined;
    const spanAttributes = { ...attributes };

    return {
      traceId,
      requestId,
      spanId,
      parentSpanId,
      setAttribute(key, value) {
        spanAttributes[key] = value;
      },
      recordError(cause) {
        status = 'error';
        error = formatError(cause);
      },
      run: <T>(callback: () => T): T =>
        contextStore.run(
          {
            traceId,
            requestId,
            activeSpanId: spanId,
          },
          callback,
        ),
      end: (finalStatus?: SpanStatus) => {
        const endedAt = Date.now();
        this.logger.logSpan({
          traceId,
          requestId,
          spanId,
          parentSpanId,
          name,
          kind,
          status: finalStatus ?? status,
          startedAt: startedAt.toISOString(),
          durationMs: endedAt - startedAt.getTime(),
          attributes: spanAttributes,
          error,
        });
      },
    };
  }
}
