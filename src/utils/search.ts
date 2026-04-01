/**
 * Search utility for filtering resources by keyword.
 * Performs a case-insensitive search across specified fields.
 * 
 * @param items - The array of items to search.
 * @param query - The search query string.
 * @param fields - The fields of the items to search in.
 * @returns Filtered array of items.
 */
export function searchItems<T>(items: T[], query: string, fields: (keyof T)[]): T[] {
  if (!query) return items;

  const lowerQuery = query.toLowerCase();

  return items.filter((item) => {
    return fields.some((field) => {
      const value = item[field];
      if (typeof value === 'string') {
        return value.toLowerCase().includes(lowerQuery);
      }
      return false;
    });
  });
}
