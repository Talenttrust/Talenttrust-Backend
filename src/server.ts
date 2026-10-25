import { Server } from 'http';
import { Socket, AddressInfo } from 'net';
import type { Application } from 'express';

export interface ServerTimeouts {
  keepAliveTimeoutMs: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
}

export interface StartServerOptions {
  app: Application;
  port: number;
  timeouts?: Partial<ServerTimeouts>;
  shutdownGraceMs?: number;
  logger?: (message: string) => void;
}

export interface StartServerResult {
  server: Server;
  port: number;
  close: () => Promise<{ forced: boolean }>;
}

const DEFAULT_TIMEOUTS: ServerTimeouts = {
  keepAliveTimeoutMs: 65_000,
  headersTimeoutMs: 66_000,
  requestTimeoutMs: 30_000,
};

const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_PORT = 3001;

export function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new Error(`Invalid PORT: "${raw}". Must be an integer between 1 and 65535.`);
  }
  return n;
}

export function resolveTimeouts(env: NodeJS.ProcessEnv): ServerTimeouts {
  const keepAlive = env.KEEP_ALIVE_TIMEOUT_MS ? Number(env.KEEP_ALIVE_TIMEOUT_MS) : DEFAULT_TIMEOUTS.keepAliveTimeoutMs;
  const headers = env.HEADERS_TIMEOUT_MS ? Number(env.HEADERS_TIMEOUT_MS) : DEFAULT_TIMEOUTS.headersTimeoutMs;
  const request = env.REQUEST_TIMEOUT_MS ? Number(env.REQUEST_TIMEOUT_MS) : DEFAULT_TIMEOUTS.requestTimeoutMs;

  if (!Number.isFinite(keepAlive) || keepAlive <= 0) {
    throw new Error(`Invalid KEEP_ALIVE_TIMEOUT_MS: "${env.KEEP_ALIVE_TIMEOUT_MS}". Must be a positive number.`);
  }
  if (!Number.isFinite(headers) || headers <= 0) {
    throw new Error(`Invalid HEADERS_TIMEOUT_MS: "${env.HEADERS_TIMEOUT_MS}". Must be a positive number.`);
  }
  if (!Number.isFinite(request) || request <= 0) {
    throw new Error(`Invalid REQUEST_TIMEOUT_MS: "${env.REQUEST_TIMEOUT_MS}". Must be a positive number.`);
  }
  if (headers <= keepAlive) {
    throw new Error(
      `HEADERS_TIMEOUT_MS (${headers}) must be greater than KEEP_ALIVE_TIMEOUT_MS (${keepAlive}).`,
    );
  }
  return { keepAliveTimeoutMs: keepAlive, headersTimeoutMs: headers, requestTimeoutMs: request };
}

export function startServer({
  app,
  port,
  timeouts,
  shutdownGraceMs,
  logger,
}: StartServerOptions): StartServerResult {
  const log = logger ?? ((msg: string) => console.log(msg));
  const resolved = { ...DEFAULT_TIMEOUTS, ...(timeouts ?? {}) };
  const graceMs = shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

  let draining = false;
  app.set('draining', false);

  let activeRequests = 0;
  const server = app.listen(port, () => {
    const addr = server.address() as AddressInfo;
    log(`TalentTrust API listening on http://localhost:${addr.port}`);
  });

  server.keepAliveTimeout = resolved.keepAliveTimeoutMs;
  server.headersTimeout = resolved.headersTimeoutMs;

  server.on('request', (_req, res) => {
    activeRequests++;
    if (draining) {
      res.setHeader('Connection', 'close');
    }
    let finished = false;
    const markDone = () => {
      if (!finished) {
        finished = true;
        activeRequests--;
      }
    };
    res.on('finish', markDone);
    res.on('close', markDone);
  });

  async function close(): Promise<{ forced: boolean }> {
    draining = true;
    app.set('draining', true);

    return new Promise((resolve) => {
      server.close(() => {
        // Stopped accepting new connections.
      });
      server.closeIdleConnections();

      const start = Date.now();
      const poll = () => {
        if (activeRequests === 0) {
          resolve({ forced: false });
          return;
        }
        if (Date.now() - start >= graceMs) {
          server.closeAllConnections();
          resolve({ forced: true });
          return;
        }
        setTimeout(poll, 20);
      };
      poll();
    });
  }

  function handleSigTerm() {
    void close().then((result) => {
      process.exit(result.forced ? 1 : 0);
    });
  }

  process.on('SIGTERM', handleSigTerm);
  process.on('SIGINT', handleSigTerm);

  return {
    server,
    port: (server.address() as AddressInfo).port,
    close,
  };
}
