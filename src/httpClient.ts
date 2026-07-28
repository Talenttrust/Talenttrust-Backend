import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  InternalAxiosRequestConfig,
  AxiosResponse,
  AxiosError,
} from 'axios';
import { logger } from './logger';
import { redactHeaders, redactUrl, normalizeUrlPath } from './redact';

// Symbol used to stamp the request start time onto the config object
const START_TIME = Symbol('startTime');

/** Typed error thrown by the HTTP client so callers can branch on HTTP status. */
export class HttpResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'HttpResponseError';
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

interface TimedAxiosConfig extends InternalAxiosRequestConfig {
  [START_TIME]?: number;
}

/**
 * Builds a structured log entry for an outgoing request / incoming response.
 * All sensitive data is stripped before the object is handed to the logger.
 */
function buildLogEntry(
  dependencyName: string,
  method: string,
  url: string,
  timingMs: number,
  httpStatus?: number,
  error?: string,
) {
  return {
    dependency_name: dependencyName,
    request_method: method.toUpperCase(),
    request_url: redactUrl(url),
    url_pattern: normalizeUrlPath(url),
    timing_ms: timingMs,
    ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * Creates an Axios instance instrumented with:
 *  - request/response structured logging via Pino
 *  - automatic header & URL redaction
 *  - cardinality-safe URL normalisation
 *
 * @param dependencyName  Human-readable name shown in logs (e.g. "Stripe-API")
 * @param baseConfig      Optional Axios config merged into the instance
 */
export function createHttpClient(
  dependencyName: string,
  baseConfig: AxiosRequestConfig = {},
): AxiosInstance {
  const instance = axios.create(baseConfig);

  // ── Request interceptor ──────────────────────────────────────────────────
  instance.interceptors.request.use((config: TimedAxiosConfig) => {
    config[START_TIME] = Date.now();

    logger.debug(
      'outgoing_request',
      {
        dependency_name: dependencyName,
        request_method: (config.method ?? 'GET').toUpperCase(),
        request_url: redactUrl(config.url ?? ''),
        url_pattern: normalizeUrlPath(config.url ?? ''),
        // Log only safe headers
        request_headers: redactHeaders(
          (config.headers as Record<string, string | string[] | undefined>) ?? {},
        ),
      }
    );

    return config;
  });

  // ── Response interceptor (success) ──────────────────────────────────────
  instance.interceptors.response.use(
    (response: AxiosResponse) => {
      const config = response.config as TimedAxiosConfig;
      const timingMs = Date.now() - (config[START_TIME] ?? Date.now());

      logger.info(
        'http_response',
        buildLogEntry(
          dependencyName,
          config.method ?? 'GET',
          config.url ?? '',
          timingMs,
          response.status,
        )
      );

      return response;
    },

    // ── Response interceptor (error / timeout) ───────────────────────────
    (error: AxiosError) => {
      const config = (error.config ?? {}) as TimedAxiosConfig;
      const timingMs = Date.now() - (config[START_TIME] ?? Date.now());

      // Expose only the error code — never the raw message which may contain PII
      const safeError = (error.cause as NodeJS.ErrnoException)?.code
        ?? error.code
        ?? 'UNKNOWN_ERROR';

      logger.error(
        'http_error',
        buildLogEntry(
          dependencyName,
          config.method ?? 'GET',
          config.url ?? '',
          timingMs,
          error.response?.status,
          safeError,
        )
      );

      if (error.response) {
        return Promise.reject(
          new HttpResponseError(
            error.response.status,
            error.response.statusText,
            error.response.data,
            `HTTP ${error.response.status} ${error.response.statusText}`,
          ),
        );
      }

      return Promise.reject(error);
    },
  );

  return instance;
}
