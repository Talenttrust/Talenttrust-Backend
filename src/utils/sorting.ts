/**
 * Sorting utility for ordering resources.
 * Supports ascending and descending order on specified fields.
 * Includes safety checks to prevent sorting on non-existent or sensitive fields.
 * 
 * @param items - The array of items to sort.
 * @param sortBy - The field to sort by.
 * @param order - The sort order ('asc' or 'desc').
 * @param allowedFields - The fields that are allowed for sorting.
 * @returns Sorted array of items.
 */
export function sortItems<T>(
  items: T[],
  sortBy: keyof T | undefined,
  order: 'asc' | 'desc' = 'asc',
  allowedFields: (keyof T)[]
): T[] {
  if (!sortBy || !allowedFields.includes(sortBy)) {
    return items;
  }

  const sortedItems = [...items].sort((a, b) => {
    const valueA = a[sortBy];
    const valueB = b[sortBy];

    if (valueA < valueB) {
      return order === 'asc' ? -1 : 1;
    }
    if (valueA > valueB) {
      return order === 'asc' ? 1 : -1;
    }
    return 0;
  });

  return sortedItems;
}

/**
 * Configuration for sorting validation.
 * Defines allowed fields and orders for a specific resource type.
 */
export interface SortConfig<T> {
  /** Fields that are allowed for sorting */
  allowedFields: (keyof T)[];
  /** Allowed sort orders (default: ['asc', 'desc']) */
  allowedOrders?: ('asc' | 'desc')[];
  /** Whether to throw an error on invalid input (default: false) */
  strict?: boolean;
}

/**
 * Error thrown when sort validation fails in strict mode.
 */
export class SortValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SortValidationError';
  }
}

/**
 * Enhanced sorting utility with parameterized allowlist and strict validation.
 * Prevents SQL/sort-key injection by validating both sort fields and order parameters.
 * 
 * @param items - The array of items to sort.
 * @param sortBy - The field to sort by.
 * @param order - The sort order ('asc' or 'desc').
 * @param config - Sort configuration with allowlist.
 * @returns Sorted array of items.
 * @throws {SortValidationError} When strict mode is enabled and validation fails.
 */
export function sortItemsWithValidation<T>(
  items: T[],
  sortBy: string | undefined,
  order: string = 'asc',
  config: SortConfig<T>
): T[] {
  const { allowedFields, allowedOrders = ['asc', 'desc'], strict = false } = config;

  // Validate sortBy parameter
  if (sortBy) {
    // Check if sortBy is a string (prevent injection via non-string types)
    if (typeof sortBy !== 'string') {
      if (strict) {
        throw new SortValidationError(`Invalid sortBy type: expected string, got ${typeof sortBy}`);
      }
      return items;
    }

    // Check if sortBy is in the allowlist
    if (!allowedFields.includes(sortBy as keyof T)) {
      if (strict) {
        throw new SortValidationError(
          `Sort field '${sortBy}' is not allowed. Allowed fields: ${allowedFields.join(', ')}`
        );
      }
      return items;
    }

    // Sanitize sortBy to prevent injection attempts
    // Only allow alphanumeric characters and underscores
    const sanitizedSortBy = sortBy.replace(/[^a-zA-Z0-9_]/g, '');
    if (sanitizedSortBy !== sortBy) {
      if (strict) {
        throw new SortValidationError(`Sort field contains invalid characters: '${sortBy}'`);
      }
      return items;
    }
  }

  // Validate order parameter
  if (order && typeof order !== 'string') {
    if (strict) {
      throw new SortValidationError(`Invalid order type: expected string, got ${typeof order}`);
    }
    return items;
  }

  const normalizedOrder = order.toLowerCase() as 'asc' | 'desc';
  if (!allowedOrders.includes(normalizedOrder)) {
    if (strict) {
      throw new SortValidationError(
        `Sort order '${order}' is not allowed. Allowed orders: ${allowedOrders.join(', ')}`
      );
    }
    return items;
  }

  // If sortBy is undefined, return original items
  if (!sortBy) {
    return items;
  }

  // Perform the sort
  const sortedItems = [...items].sort((a, b) => {
    const valueA = a[sortBy as keyof T];
    const valueB = b[sortBy as keyof T];

    if (valueA < valueB) {
      return normalizedOrder === 'asc' ? -1 : 1;
    }
    if (valueA > valueB) {
      return normalizedOrder === 'asc' ? 1 : -1;
    }
    return 0;
  });

  return sortedItems;
}
