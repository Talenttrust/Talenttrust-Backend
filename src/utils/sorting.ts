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
