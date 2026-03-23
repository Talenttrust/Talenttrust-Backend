/**
 * @notice Typed operational error used by the API middleware stack.
 */
export class ApiError extends Error {
  /**
   * @param status HTTP status code to return.
   * @param message Safe user-facing message.
   */
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
