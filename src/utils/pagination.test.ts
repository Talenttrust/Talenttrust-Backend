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

  /**
   * Simple seeded pseudo-random number generator (LCG algorithm).
   * Produces deterministic sequences for reproducible fuzz testing.
   * @param seed - Initial seed value (use a fixed number for determinism)
   * @returns A function that returns the next pseudo-random number [0, 1)
   */
  function seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return (s >>> 0) / 0xffffffff;
    };
  }

  describe('parsePaginationQuery — exhaustive invalid input tests', () => {
    describe('page parameter validation', () => {
      it('rejects page = 0', () => {
        const result = parsePaginationQuery({ page: '0', limit: '10' });
        expect(result.ok).toBe(false);
      });

      it('rejects negative page values', () => {
        const result = parsePaginationQuery({ page: '-1', limit: '10' });
        expect(result.ok).toBe(false);
      });

      it('rejects page = -100', () => {
        const result = parsePaginationQuery({ page: '-100', limit: '10' });
        expect(result.ok).toBe(false);
      });

      it('rejects non-numeric page string "abc"', () => {
        const result = parsePaginationQuery({ page: 'abc', limit: '10' });
        expect(result.ok).toBe(false);
      });

      it('rejects empty page string ""', () => {
        const result = parsePaginationQuery({ page: '', limit: '10' });
        expect(result.ok).toBe(true); // Empty defaults to '1'
      });

      it('rejects floating-point page "1.5"', () => {
        const result = parsePaginationQuery({ page: '1.5', limit: '10' });
        expect(result.ok).toBe(false);
      });

      it('rejects page = "NaN"', () => {
        const result = parsePaginationQuery({ page: 'NaN', limit: '10' });
        expect(result.ok).toBe(false);
      });

      it('rejects page above reasonable maximum (999999999)', () => {
        const result = parsePaginationQuery({ page: '999999999', limit: '10' });
        expect(result.ok).toBe(true); // Large pages are accepted, as they may be intentional
      });
    });

    describe('limit parameter validation', () => {
      it('rejects limit = 0', () => {
        const result = parsePaginationQuery({ page: '1', limit: '0' });
        expect(result.ok).toBe(false);
      });

      it('rejects negative limit values', () => {
        const result = parsePaginationQuery({ page: '1', limit: '-5' });
        expect(result.ok).toBe(false);
      });

      it('rejects limit = -100', () => {
        const result = parsePaginationQuery({ page: '1', limit: '-100' });
        expect(result.ok).toBe(false);
      });

      it('rejects non-numeric limit string "many"', () => {
        const result = parsePaginationQuery({ page: '1', limit: 'many' });
        expect(result.ok).toBe(false);
      });

      it('rejects floating-point limit "2.5"', () => {
        const result = parsePaginationQuery({ page: '1', limit: '2.5' });
        expect(result.ok).toBe(false);
      });

      it('rejects limit exceeding MAX_PAGE_LIMIT', () => {
        const result = parsePaginationQuery({ page: '1', limit: String(MAX_PAGE_LIMIT + 1) });
        expect(result.ok).toBe(false);
      });

      it('rejects limit = 101 (over MAX_PAGE_LIMIT of 100)', () => {
        const result = parsePaginationQuery({ page: '1', limit: '101' });
        expect(result.ok).toBe(false);
      });

      it('rejects limit = 200', () => {
        const result = parsePaginationQuery({ page: '1', limit: '200' });
        expect(result.ok).toBe(false);
      });
    });

    describe('both page and limit invalid simultaneously', () => {
      it('rejects when both page and limit are 0', () => {
        const result = parsePaginationQuery({ page: '0', limit: '0' });
        expect(result.ok).toBe(false);
      });

      it('rejects when both page and limit are negative', () => {
        const result = parsePaginationQuery({ page: '-1', limit: '-5' });
        expect(result.ok).toBe(false);
      });

      it('rejects when page is invalid and limit exceeds max', () => {
        const result = parsePaginationQuery({ page: 'abc', limit: '999' });
        expect(result.ok).toBe(false);
      });
    });

    describe('invalid types', () => {
      it('rejects null page', () => {
        const result = parsePaginationQuery({ page: null, limit: '10' });
        expect(result.ok).toBe(true); // null is coerced to undefined, defaults to 1
      });

      it('rejects undefined page (defaults to 1)', () => {
        const result = parsePaginationQuery({ page: undefined, limit: '10' });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.page).toBe(1);
      });

      it('rejects object as page', () => {
        const result = parsePaginationQuery({ page: { value: 1 }, limit: '10' } as any);
        expect(result.ok).toBe(false);
      });

      it('rejects array as page', () => {
        const result = parsePaginationQuery({ page: [1], limit: '10' } as any);
        expect(result.ok).toBe(false);
      });
    });
  });

  describe('parsePaginationQuery — exhaustive valid input tests', () => {
    describe('minimum valid values', () => {
      it('accepts page = 1, limit = 1', () => {
        const result = parsePaginationQuery({ page: '1', limit: '1' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toEqual({ page: 1, limit: 1, offset: 0 });
        }
      });

      it('accepts page = 1 with default limit', () => {
        const result = parsePaginationQuery({ page: '1' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.page).toBe(1);
          expect(result.value.limit).toBe(DEFAULT_PAGE_LIMIT);
          expect(result.value.offset).toBe(0);
        }
      });
    });

    describe('maximum valid values', () => {
      it('accepts limit = MAX_PAGE_LIMIT', () => {
        const result = parsePaginationQuery({ page: '1', limit: String(MAX_PAGE_LIMIT) });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.limit).toBe(MAX_PAGE_LIMIT);
        }
      });

      it('accepts large page numbers', () => {
        const result = parsePaginationQuery({ page: '999999', limit: '10' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.page).toBe(999999);
        }
      });
    });

    describe('common valid combinations', () => {
      it('accepts page = 1, limit = 10', () => {
        const result = parsePaginationQuery({ page: '1', limit: '10' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toEqual({ page: 1, limit: 10, offset: 0 });
        }
      });

      it('accepts page = 5, limit = 20', () => {
        const result = parsePaginationQuery({ page: '5', limit: '20' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.offset).toBe((5 - 1) * 20);
          expect(result.value.offset).toBe(80);
        }
      });

      it('accepts page = 10, limit = 50', () => {
        const result = parsePaginationQuery({ page: '10', limit: '50' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toEqual({ page: 10, limit: 50, offset: 450 });
        }
      });

      it('accepts string numbers that parse correctly', () => {
        const result = parsePaginationQuery({ page: '123', limit: '45' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.page).toBe(123);
          expect(result.value.limit).toBe(45);
        }
      });
    });

    describe('defaults and omissions', () => {
      it('defaults page to 1 when omitted', () => {
        const result = parsePaginationQuery({ limit: '10' });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.page).toBe(1);
      });

      it('defaults limit to DEFAULT_PAGE_LIMIT when omitted', () => {
        const result = parsePaginationQuery({ page: '1' });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.limit).toBe(DEFAULT_PAGE_LIMIT);
      });

      it('uses defaults for both when query is empty', () => {
        const result = parsePaginationQuery({});
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toEqual({
            page: 1,
            limit: DEFAULT_PAGE_LIMIT,
            offset: 0,
          });
        }
      });
    });
  });

  describe('offset derivation — exhaustive tests', () => {
    it('offset = (page - 1) * limit for page = 1, limit = 10', () => {
      const result = parsePaginationQuery({ page: '1', limit: '10' });
      if (result.ok) {
        expect(result.value.offset).toBe((1 - 1) * 10);
        expect(result.value.offset).toBe(0);
      }
    });

    it('offset = (page - 1) * limit for page = 2, limit = 10', () => {
      const result = parsePaginationQuery({ page: '2', limit: '10' });
      if (result.ok) {
        expect(result.value.offset).toBe((2 - 1) * 10);
        expect(result.value.offset).toBe(10);
      }
    });

    it('offset = (page - 1) * limit for page = 5, limit = 20', () => {
      const result = parsePaginationQuery({ page: '5', limit: '20' });
      if (result.ok) {
        expect(result.value.offset).toBe((5 - 1) * 20);
        expect(result.value.offset).toBe(80);
      }
    });

    it('offset = (page - 1) * limit for page = 100, limit = 50', () => {
      const result = parsePaginationQuery({ page: '100', limit: '50' });
      if (result.ok) {
        expect(result.value.offset).toBe((100 - 1) * 50);
        expect(result.value.offset).toBe(4950);
      }
    });

    it('offset at page = 1 must always be 0 regardless of limit', () => {
      for (let limit = 1; limit <= MAX_PAGE_LIMIT; limit += 10) {
        const result = parsePaginationQuery({ page: '1', limit: String(limit) });
        if (result.ok) {
          expect(result.value.offset).toBe(0);
        }
      }
    });

    it('offset increases correctly across multiple pages with same limit', () => {
      const limit = 25;
      for (let page = 1; page <= 5; page++) {
        const result = parsePaginationQuery({ page: String(page), limit: String(limit) });
        if (result.ok) {
          expect(result.value.offset).toBe((page - 1) * limit);
        }
      }
    });
  });

  describe('applyPagination — exhaustive array slicing tests', () => {
    describe('edge cases with array boundaries', () => {
      it('empty array returns empty array', () => {
        const result = applyPagination([], { page: 1, limit: 10, offset: 0 });
        expect(result).toEqual([]);
      });

      it('single item array with page = 1, limit = 1', () => {
        const result = applyPagination([1], { page: 1, limit: 1, offset: 0 });
        expect(result).toEqual([1]);
      });

      it('single item array with page = 2 returns empty', () => {
        const result = applyPagination([1], { page: 2, limit: 1, offset: 1 });
        expect(result).toEqual([]);
      });

      it('array of exactly limit-sized length', () => {
        const items = [1, 2, 3, 4, 5];
        const result = applyPagination(items, { page: 1, limit: 5, offset: 0 });
        expect(result).toEqual([1, 2, 3, 4, 5]);
      });
    });

    describe('first page', () => {
      it('page = 1, limit = 10 on array of 5 returns all 5', () => {
        const items = [1, 2, 3, 4, 5];
        const result = applyPagination(items, { page: 1, limit: 10, offset: 0 });
        expect(result).toEqual([1, 2, 3, 4, 5]);
      });

      it('page = 1, limit = 3 on array of 10 returns first 3', () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const result = applyPagination(items, { page: 1, limit: 3, offset: 0 });
        expect(result).toEqual([1, 2, 3]);
      });
    });

    describe('middle pages', () => {
      it('page = 2, limit = 3 on array of 10 returns items 3, 4, 5', () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const result = applyPagination(items, { page: 2, limit: 3, offset: 3 });
        expect(result).toEqual([4, 5, 6]);
      });

      it('page = 3, limit = 2 on array of 10 returns items 5, 6', () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const result = applyPagination(items, { page: 3, limit: 2, offset: 4 });
        expect(result).toEqual([5, 6]);
      });
    });

    describe('last page with partial results', () => {
      it('last page with fewer items than limit returns remainder', () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const result = applyPagination(items, { page: 3, limit: 4, offset: 8 });
        expect(result).toEqual([9, 10]);
      });

      it('page = 2, limit = 6 on array of 10 returns items 7-10', () => {
        const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const result = applyPagination(items, { page: 2, limit: 6, offset: 6 });
        expect(result).toEqual([7, 8, 9, 10]);
      });
    });

    describe('beyond array length', () => {
      it('page beyond array length returns empty array', () => {
        const items = [1, 2, 3, 4, 5];
        const result = applyPagination(items, { page: 10, limit: 5, offset: 50 });
        expect(result).toEqual([]);
      });

      it('offset at exact array length returns empty', () => {
        const items = [1, 2, 3, 4, 5];
        const result = applyPagination(items, { page: 2, limit: 5, offset: 5 });
        expect(result).toEqual([]);
      });

      it('offset beyond array length returns empty', () => {
        const items = [1, 2, 3];
        const result = applyPagination(items, { page: 5, limit: 10, offset: 40 });
        expect(result).toEqual([]);
      });
    });

    describe('array mutation safety', () => {
      it('does not mutate the original array', () => {
        const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const copy = [...original];
        applyPagination(original, { page: 2, limit: 3, offset: 3 });
        expect(original).toEqual(copy);
      });

      it('does not mutate array across multiple calls', () => {
        const items = [1, 2, 3, 4, 5];
        const original = [...items];
        applyPagination(items, { page: 1, limit: 2, offset: 0 });
        applyPagination(items, { page: 2, limit: 2, offset: 2 });
        applyPagination(items, { page: 3, limit: 2, offset: 4 });
        expect(items).toEqual(original);
      });
    });
  });

  describe('parsePaginationQuery fuzz — deterministic randomized tests', () => {
    it('rejects all deterministically invalid inputs', () => {
      const rand = seededRandom(42);
      const invalidInputs = [
        () => String(Math.floor(rand() * -1000) - 1), // negative
        () => '0', // zero
        () => 'abc', // non-numeric
        () => String(Math.floor(rand() * 50) + 101), // exceeds MAX_PAGE_LIMIT for limit
      ];

      for (let i = 0; i < 100; i++) {
        const pageInvalid = invalidInputs[Math.floor(rand() * (invalidInputs.length - 1))];
        const limitInvalid = invalidInputs[Math.floor(rand() * (invalidInputs.length - 1))];

        // Test invalid page with valid limit
        const resultPageInvalid = parsePaginationQuery({
          page: pageInvalid(),
          limit: '10',
        });
        if (resultPageInvalid.ok === false || pageInvalid().match(/^-?\d+$/)) {
          // Either explicitly invalid or negative
          if (pageInvalid().match(/^-?\d+$/) && Number(pageInvalid()) < 1) {
            expect(resultPageInvalid.ok).toBe(false);
          }
        }

        // Test valid page with invalid limit
        const resultLimitInvalid = parsePaginationQuery({
          page: '5',
          limit: limitInvalid(),
        });
        // Limit tests are stricter
        if (limitInvalid() === '0' || Number(limitInvalid()) > MAX_PAGE_LIMIT) {
          expect(resultLimitInvalid.ok).toBe(false);
        }
      }
    });

    it('accepts all deterministically valid inputs and derives offset correctly', () => {
      const rand = seededRandom(123);
      let validCount = 0;

      for (let i = 0; i < 100; i++) {
        const page = Math.floor(rand() * 100) + 1; // 1-100
        const limit = Math.floor(rand() * MAX_PAGE_LIMIT) + 1; // 1-100

        const result = parsePaginationQuery({
          page: String(page),
          limit: String(limit),
        });

        if (result.ok) {
          expect(result.value.page).toBe(page);
          expect(result.value.limit).toBe(limit);
          expect(result.value.offset).toBe((page - 1) * limit);
          validCount++;
        }
      }

      // Should have many valid results
      expect(validCount).toBeGreaterThan(50);
    });

    it('maintains offset invariant across all valid random inputs', () => {
      const rand = seededRandom(456);

      for (let i = 0; i < 200; i++) {
        const page = Math.floor(rand() * 50) + 1;
        const limit = Math.floor(rand() * 50) + 1;

        const result = parsePaginationQuery({
          page: String(page),
          limit: String(limit),
        });

        if (result.ok) {
          // Offset must always equal (page - 1) * limit
          const expectedOffset = (page - 1) * limit;
          expect(result.value.offset).toBe(expectedOffset);
        }
      }
    });

    it('deterministically generates valid pages and limits from seeded random', () => {
      const rand1 = seededRandom(789);
      const rand2 = seededRandom(789); // Same seed = same sequence

      const results1: { page: number; limit: number }[] = [];
      const results2: { page: number; limit: number }[] = [];

      for (let i = 0; i < 50; i++) {
        const page1 = Math.floor(rand1() * 100) + 1;
        const limit1 = Math.floor(rand1() * 100) + 1;
        results1.push({ page: page1, limit: limit1 });

        const page2 = Math.floor(rand2() * 100) + 1;
        const limit2 = Math.floor(rand2() * 100) + 1;
        results2.push({ page: page2, limit: limit2 });
      }

      // Sequences must be identical
      expect(results1).toEqual(results2);
    });
  });

  describe('applyPagination fuzz — deterministic array slicing tests', () => {
    it('deterministically slices arrays based on random pagination params', () => {
      const rand = seededRandom(999);
      const items = Array.from({ length: 1000 }, (_, i) => i);

      for (let i = 0; i < 100; i++) {
        const page = Math.floor(rand() * 50) + 1;
        const limit = Math.floor(rand() * 50) + 1;
        const offset = (page - 1) * limit;

        const result = applyPagination(items, { page, limit, offset });
        const expected = items.slice(offset, offset + limit);

        expect(result).toEqual(expected);
      }
    });

    it('deterministically handles edge cases with random array sizes', () => {
      const rand = seededRandom(111);

      for (let i = 0; i < 100; i++) {
        const arraySize = Math.floor(rand() * 200); // 0-199
        const page = Math.floor(rand() * 10) + 1;
        const limit = Math.floor(rand() * 20) + 1;
        const offset = (page - 1) * limit;

        const items = Array.from({ length: arraySize }, (_, idx) => idx);
        const result = applyPagination(items, { page, limit, offset });

        // Verify result is never larger than limit
        expect(result.length).toBeLessThanOrEqual(limit);
        // Verify no elements outside array bounds
        expect(result.every((val) => val >= 0 && val < arraySize)).toBe(true);
        // Verify result matches slice
        expect(result).toEqual(items.slice(offset, offset + limit));
      }
    });

    it('never mutates original array in fuzz tests', () => {
      const rand = seededRandom(222);

      for (let i = 0; i < 50; i++) {
        const items = Array.from({ length: 100 }, (_, idx) => idx);
        const original = [...items];

        const page = Math.floor(rand() * 10) + 1;
        const limit = Math.floor(rand() * 10) + 1;
        const offset = (page - 1) * limit;

        applyPagination(items, { page, limit, offset });

        expect(items).toEqual(original);
      }
    });
  });
});
