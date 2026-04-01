import { getPaginationOptions, getPaginationMetadata } from './pagination';

describe('Pagination Utility', () => {
  describe('getPaginationOptions', () => {
    it('should return default options when query is empty', () => {
      const options = getPaginationOptions({});
      expect(options).toEqual({ page: 1, limit: 10, offset: 0 });
    });

    it('should parse page and limit from query', () => {
      const options = getPaginationOptions({ page: '2', limit: '20' });
      expect(options).toEqual({ page: 2, limit: 20, offset: 20 });
    });

    it('should handle invalid page and limit values', () => {
      const options = getPaginationOptions({ page: 'abc', limit: '-5' });
      expect(options).toEqual({ page: 1, limit: 1, offset: 0 });
    });

    it('should cap the limit at 100', () => {
      const options = getPaginationOptions({ limit: '200' });
      expect(options.limit).toBe(100);
    });

    it('should use custom default limit', () => {
      const options = getPaginationOptions({}, 50);
      expect(options.limit).toBe(50);
    });
  });

  describe('getPaginationMetadata', () => {
    it('should generate correct metadata', () => {
      const totalItems = 100;
      const options = { page: 1, limit: 10, offset: 0 };
      const itemCount = 10;
      const meta = getPaginationMetadata(totalItems, options, itemCount);

      expect(meta).toEqual({
        totalItems: 100,
        itemCount: 10,
        itemsPerPage: 10,
        totalPages: 10,
        currentPage: 1,
      });
    });

    it('should handle cases with partial pages', () => {
      const totalItems = 105;
      const options = { page: 11, limit: 10, offset: 100 };
      const itemCount = 5;
      const meta = getPaginationMetadata(totalItems, options, itemCount);

      expect(meta.totalPages).toBe(11);
      expect(meta.currentPage).toBe(11);
    });
  });
});
