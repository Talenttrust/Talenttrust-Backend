/**
 * @title Pagination Utility
 * @notice Provides reusable functions and interfaces for handling pagination in API endpoints.
 * @dev This module includes logic for parsing pagination parameters and generating pagination metadata.
 */

export interface PaginationOptions {
  page: number;
  limit: number;
  offset: number;
}

export interface PaginationMetadata {
  totalItems: number;
  itemCount: number;
  itemsPerPage: number;
  totalPages: number;
  currentPage: number;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: PaginationMetadata;
}

/**
 * @notice Parses pagination query parameters and returns structured pagination options.
 * @param query The query parameters from the request.
 * @param defaultLimit The default number of items per page.
 * @returns An object containing the page, limit, and offset.
 */
export function getPaginationOptions(
  query: { page?: any; limit?: any },
  defaultLimit: number = 10
): PaginationOptions {
  const page = Math.max(1, parseInt(query.page as string, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(query.limit as string, 10) || defaultLimit));
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}

/**
 * @notice Generates pagination metadata based on total items and pagination options.
 * @param totalItems The total number of items available.
 * @param options The pagination options used for the query.
 * @param itemCount The number of items returned in the current page.
 * @returns A structured pagination metadata object.
 */
export function getPaginationMetadata(
  totalItems: number,
  options: PaginationOptions,
  itemCount: number
): PaginationMetadata {
  const totalPages = Math.ceil(totalItems / options.limit);

  return {
    totalItems,
    itemCount,
    itemsPerPage: options.limit,
    totalPages,
    currentPage: options.page,
  };
}
