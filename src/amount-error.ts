/**
 * HttpError — shared error class used by both amount.ts and store.ts.
 * Extracted here to avoid a circular import between amount.ts ↔ store.ts.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
