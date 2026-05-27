import {
  getPaginationOptions,
  getPaginationMetadata,
  paginationQuerySchema,
  parsePaginationQuery,
  applyPagination,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT,
} from './pagination';

describe('Pagination Utility', () => {
  describe('constants', () => {
    it('MAX_PAGE_LIMIT should be 100', () => {
      expect(MAX_PAGE_LIMIT).toBe(100);
    });

    it('DEFAULT_PAGE_LIMIT should be 20', () => {
      expect(DEFAULT_PAGE_LIMIT).toBe(20);
    });
  });

  describe('paginationQuerySchema', () => {
    describe('valid inputs', () => {
      it('accepts valid page and limit', () => {
        const result = paginationQuerySchema.safeParse({ page: '2', limit: '25' });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual({ page: 2, limit: 25 });
        }
      });

      it('defaults page to 1 when omitted', () => {
        const result = paginationQuerySchema.safeParse({ limit: '10' });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.page).toBe(1);
      });

      it('defaults limit to DEFAULT_PAGE_LIMIT when omitted', () => {
        const result = paginationQuerySchema.safeParse({ page: '1' });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.limit).toBe(DEFAULT_PAGE_LIMIT);
      });

      it('defaults both params when query is empty', () => {
        const result = paginationQuerySchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.page).toBe(1);
          expect(result.data.limit).toBe(DEFAULT_PAGE_LIMIT);
        }
      });

      it('accepts limit equal to MAX_PAGE_LIMIT', () => {
        const result = paginationQuerySchema.safeParse({ limit: String(MAX_PAGE_LIMIT) });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.limit).toBe(MAX_PAGE_LIMIT);
      });

      it('accepts limit of 1', () => {
        const result = paginationQuerySchema.safeParse({ limit: '1' });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.limit).toBe(1);
      });
    });

    describe('rejection policy — invalid values are rejected, not clamped', () => {
      it('rejects a negative page value', () => {
        const result = paginationQuerySchema.safeParse({ page: '-1' });
        expect(result.success).toBe(false);
      });

      it('rejects page = 0', () => {
        const result = paginationQuerySchema.safeParse({ page: '0' });
        expect(result.success).toBe(false);
      });

      it('rejects a non-numeric page string', () => {
        const result = paginationQuerySchema.safeParse({ page: 'abc' });
        expect(result.success).toBe(false);
      });

      it('rejects a floating-point page string', () => {
        const result = paginationQuerySchema.safeParse({ page: '1.5' });
        expect(result.success).toBe(false);
      });

      it('rejects a negative limit value', () => {
        const result = paginationQuerySchema.safeParse({ limit: '-5' });
        expect(result.success).toBe(false);
      });

      it('rejects limit = 0', () => {
        const result = paginationQuerySchema.safeParse({ limit: '0' });
        expect(result.success).toBe(false);
      });

      it('rejects limit exceeding MAX_PAGE_LIMIT', () => {
        const result = paginationQuerySchema.safeParse({ limit: String(MAX_PAGE_LIMIT + 1) });
        expect(result.success).toBe(false);
      });

      it('rejects a non-numeric limit string', () => {
        const result = paginationQuerySchema.safeParse({ limit: 'many' });
        expect(result.success).toBe(false);
      });

      it('rejects a floating-point limit string', () => {
        const result = paginationQuerySchema.safeParse({ limit: '2.5' });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('parsePaginationQuery', () => {
    it('returns ok:true with correct options for valid input', () => {
      const result = parsePaginationQuery({ page: '3', limit: '15' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ page: 3, limit: 15, offset: 30 });
      }
    });

    it('returns ok:true with defaults when query is empty', () => {
      const result = parsePaginationQuery({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.page).toBe(1);
        expect(result.value.limit).toBe(DEFAULT_PAGE_LIMIT);
        expect(result.value.offset).toBe(0);
      }
    });

    it('computes offset as (page - 1) * limit', () => {
      const result = parsePaginationQuery({ page: '5', limit: '10' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.offset).toBe(40);
    });

    it('returns ok:false with error message for negative page', () => {
      const result = parsePaginationQuery({ page: '-1' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(typeof result.error).toBe('string');
    });

    it('returns ok:false for limit exceeding MAX_PAGE_LIMIT', () => {
      const result = parsePaginationQuery({ limit: '999' });
      expect(result.ok).toBe(false);
    });

    it('returns ok:false for NaN page input', () => {
      const result = parsePaginationQuery({ page: 'NaN' });
      expect(result.ok).toBe(false);
    });
  });

  describe('applyPagination', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    it('returns the correct page window', () => {
      const result = applyPagination(items, { page: 2, limit: 3, offset: 3 });
      expect(result).toEqual([4, 5, 6]);
    });

    it('returns the first page correctly', () => {
      const result = applyPagination(items, { page: 1, limit: 4, offset: 0 });
      expect(result).toEqual([1, 2, 3, 4]);
    });

    it('returns an empty array when offset is beyond the dataset', () => {
      const result = applyPagination(items, { page: 10, limit: 5, offset: 50 });
      expect(result).toEqual([]);
    });

    it('returns a partial page at the end of the dataset', () => {
      const result = applyPagination(items, { page: 3, limit: 4, offset: 8 });
      expect(result).toEqual([9, 10]);
    });

    it('does not mutate the original array', () => {
      const original = [...items];
      applyPagination(items, { page: 1, limit: 3, offset: 0 });
      expect(items).toEqual(original);
    });
  });

  describe('getPaginationOptions (clamping variant)', () => {
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
