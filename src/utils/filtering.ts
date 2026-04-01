/**
 * @title Filtering Utility
 * @notice Provides reusable functions and interfaces for handling filtering in API endpoints.
 * @dev This module includes logic for parsing filtering parameters from query strings.
 */

export interface FilterOptions {
  [key: string]: any;
}

/**
 * @notice Parses filtering parameters from query string and returns a structured object.
 * @param query The query parameters from the request.
 * @param allowedFilters An array of allowed filter keys.
 * @returns An object containing the filtered keys and their values.
 */
export function getFilterOptions(
  query: { [key: string]: any },
  allowedFilters: string[]
): FilterOptions {
  const filters: FilterOptions = {};

  allowedFilters.forEach((key) => {
    if (query[key] !== undefined) {
      filters[key] = query[key];
    }
  });

  return filters;
}

/**
 * @notice Sanitizes filtering parameters to prevent injection or invalid queries.
 * @param filters The filtering options to sanitize.
 * @returns A sanitized object containing only allowed types.
 */
export function sanitizeFilters(filters: FilterOptions): FilterOptions {
  const sanitized: FilterOptions = {};

  Object.entries(filters).forEach(([key, value]) => {
    // Basic sanitization: only allow primitive types for now
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    }
  });

  return sanitized;
}
