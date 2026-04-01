import { getFilterOptions, sanitizeFilters } from './filtering';

describe('Filtering Utility', () => {
  describe('getFilterOptions', () => {
    it('should extract allowed filters from query', () => {
      const query = { status: 'active', type: 'full-time', unknown: 'value' };
      const allowedFilters = ['status', 'type'];
      const filters = getFilterOptions(query, allowedFilters);

      expect(filters).toEqual({ status: 'active', type: 'full-time' });
      expect(filters.unknown).toBeUndefined();
    });

    it('should handle missing filter parameters', () => {
      const query = { status: 'active' };
      const allowedFilters = ['status', 'type'];
      const filters = getFilterOptions(query, allowedFilters);

      expect(filters).toEqual({ status: 'active' });
    });

    it('should return empty object if no allowed filters are present', () => {
      const query = { unknown: 'value' };
      const allowedFilters = ['status', 'type'];
      const filters = getFilterOptions(query, allowedFilters);

      expect(filters).toEqual({});
    });
  });

  describe('sanitizeFilters', () => {
    it('should only allow primitive types', () => {
      const filters = {
        status: 'active',
        limit: 10,
        active: true,
        nested: { key: 'value' },
        array: [1, 2, 3],
      };
      const sanitized = sanitizeFilters(filters);

      expect(sanitized).toEqual({
        status: 'active',
        limit: 10,
        active: true,
      });
      expect(sanitized.nested).toBeUndefined();
      expect(sanitized.array).toBeUndefined();
    });

    it('should handle empty filters', () => {
      const sanitized = sanitizeFilters({});
      expect(sanitized).toEqual({});
    });
  });
});
