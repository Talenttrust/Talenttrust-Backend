/**
 * HttpError — shared error class used by amount.ts, store.ts and the routes.
 * Extracted here to avoid a circular import between amount.ts ↔ store.ts.
 *
 * Two forms:
 *   new HttpError('over_funded', message?, details?)   // typed catalog key (preferred)
 *   new HttpError(409, 'over_funded', message, details) // explicit status + code
 * Either way the error renders as RFC 9457 problem+json (see toProblemBody).
 */
import { ERRORS, PROBLEM_TYPE_BASE, isErrorKey, type ErrorEntry, type ErrorKey } from './errors';

export class HttpError extends Error {
  public status: number;
  public code: string;
  public details?: Record<string, unknown>;

  constructor(key: ErrorKey, message?: string, details?: Record<string, unknown>);
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>);
  constructor(
    statusOrKey: number | ErrorKey,
    codeOrMessage?: string,
    messageOrDetails?: string | Record<string, unknown>,
    details?: Record<string, unknown>,
  ) {
    if (typeof statusOrKey === 'number') {
      super(codeOrMessage === undefined ? 'Error' : (messageOrDetails as string));
      this.status = statusOrKey;
      this.code = codeOrMessage ?? 'internal_error';
      this.details = details;
    } else {
      const entry: ErrorEntry = ERRORS[statusOrKey];
      super(codeOrMessage ?? entry.detail);
      this.status = entry.status;
      this.code = statusOrKey;
      this.details = messageOrDetails as Record<string, unknown> | undefined;
    }
    this.name = 'HttpError';
  }

  /** Catalog entry for this code, if it is a known one. */
  get entry(): ErrorEntry | undefined {
    return isErrorKey(this.code) ? ERRORS[this.code] : undefined;
  }

  /** Problem type URI for this error code. */
  get type(): string {
    return `${PROBLEM_TYPE_BASE}/${this.code}`;
  }

  get contractError(): { name: string; code: number } | undefined {
    return this.entry?.contractError;
  }

  /** RFC 9457 body; `error`/`message` are kept for existing clients. */
  toProblemBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      type: this.type,
      title: this.entry?.title ?? this.code,
      status: this.status,
      detail: this.message,
      error: this.code,
      message: this.message,
    };
    if (this.contractError) body.contractError = this.contractError;
    if (this.details) Object.assign(body, this.details);
    return body;
  }
}
