import { sortItems, sortItemsWithValidation, SortConfig, SortValidationError } from '../utils/sorting';

interface TestItem {
  id: number;
  name: string;
  value: number;
}

const testItems: TestItem[] = [
  { id: 1, name: 'Apple', value: 3.5 },
  { id: 2, name: 'Banana', value: 2.0 },
  { id: 3, name: 'Cherry', value: 5.0 },
];

describe('sortItems', () => {
  const allowedFields: (keyof TestItem)[] = ['name', 'value'];

  it('should return original items when sortBy is undefined', () => {
    const result = sortItems(testItems, undefined, 'asc', allowedFields);
    expect(result).toEqual(testItems);
  });

  it('should return original items when sortBy is not allowed', () => {
    const result = sortItems(testItems, 'id' as any, 'asc', allowedFields);
    expect(result).toEqual(testItems);
  });

  it('should sort by name in ascending order', () => {
    const result = sortItems(testItems, 'name', 'asc', allowedFields);
    expect(result[0].name).toBe('Apple');
    expect(result[1].name).toBe('Banana');
    expect(result[2].name).toBe('Cherry');
  });

  it('should sort by name in descending order', () => {
    const result = sortItems(testItems, 'name', 'desc', allowedFields);
    expect(result[0].name).toBe('Cherry');
    expect(result[1].name).toBe('Banana');
    expect(result[2].name).toBe('Apple');
  });

  it('should sort by value in ascending order', () => {
    const result = sortItems(testItems, 'value', 'asc', allowedFields);
    expect(result[0].value).toBe(2.0);
    expect(result[1].value).toBe(3.5);
    expect(result[2].value).toBe(5.0);
  });

  it('should sort by value in descending order', () => {
    const result = sortItems(testItems, 'value', 'desc', allowedFields);
    expect(result[0].value).toBe(5.0);
    expect(result[1].value).toBe(3.5);
    expect(result[2].value).toBe(2.0);
  });

  it('should not mutate original items array', () => {
    const original = [...testItems];
    sortItems(testItems, 'name', 'asc', allowedFields);
    expect(testItems).toEqual(original);
  });

  it('should handle items with equal values', () => {
    const itemsWithEqualValues = [
      { id: 1, name: 'Apple', value: 10 },
      { id: 2, name: 'Banana', value: 10 },
    ];
    const result = sortItems(itemsWithEqualValues, 'value', 'asc', allowedFields);
    expect(result).toEqual(itemsWithEqualValues);
  });

  it('should use default order (asc) when order is omitted', () => {
    // @ts-ignore - testing default parameter
    const result = sortItems(testItems, 'value', undefined, allowedFields);
    expect(result[0].value).toBe(2.0);
    expect(result[2].value).toBe(5.0);
  });
});

describe('sortItemsWithValidation — allowlist and injection prevention', () => {
  const config: SortConfig<TestItem> = {
    allowedFields: ['name', 'value'],
    allowedOrders: ['asc', 'desc'],
    strict: false
  };

  it('should sort by allowed field in non-strict mode', () => {
    const result = sortItemsWithValidation(testItems, 'name', 'asc', config);
    expect(result[0].name).toBe('Apple');
    expect(result[1].name).toBe('Banana');
    expect(result[2].name).toBe('Cherry');
  });

  it('should return original items when sortBy is not in allowlist (non-strict)', () => {
    const result = sortItemsWithValidation(testItems, 'id', 'asc', config);
    expect(result).toEqual(testItems);
  });

  it('should return original items when order is not allowed (non-strict)', () => {
    const result = sortItemsWithValidation(testItems, 'name', 'random', config);
    expect(result).toEqual(testItems);
  });

  it('should handle case-insensitive order parameter', () => {
    const result = sortItemsWithValidation(testItems, 'name', 'ASC', config);
    expect(result[0].name).toBe('Apple');
    expect(result[2].name).toBe('Cherry');
  });

  it('should handle undefined sortBy', () => {
    const result = sortItemsWithValidation(testItems, undefined, 'asc', config);
    expect(result).toEqual(testItems);
  });

  it('should not mutate original items array', () => {
    const original = [...testItems];
    sortItemsWithValidation(testItems, 'name', 'asc', config);
    expect(testItems).toEqual(original);
  });

  it('should reject sort field with special characters in strict mode', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    expect(() => {
      sortItemsWithValidation(testItems, 'name; DROP TABLE users--', 'asc', strictConfig);
    }).toThrow(SortValidationError);
  });

  it('should reject sort field with SQL injection attempt in strict mode', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    expect(() => {
      sortItemsWithValidation(testItems, "name' OR '1'='1", 'asc', strictConfig);
    }).toThrow(SortValidationError);
  });

  it('should reject sort field with path traversal attempt in strict mode', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    expect(() => {
      sortItemsWithValidation(testItems, '../../../etc/passwd', 'asc', strictConfig);
    }).toThrow(SortValidationError);
  });

  it('should reject sort field with XSS attempt in strict mode', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    expect(() => {
      sortItemsWithValidation(testItems, '<script>alert(1)</script>', 'asc', strictConfig);
    }).toThrow(SortValidationError);
  });

  it('should reject sort field with null byte injection in strict mode', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    expect(() => {
      sortItemsWithValidation(testItems, 'name\x00', 'asc', strictConfig);
    }).toThrow(SortValidationError);
  });

  it('should reject non-allowed field in strict mode', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    expect(() => {
      sortItemsWithValidation(testItems, 'id', 'asc', strictConfig);
    }).toThrow(SortValidationError);
    expect(() => {
      sortItemsWithValidation(testItems, 'id', 'asc', strictConfig);
    }).toThrow('Sort field \'id\' is not allowed');
  });

  it('should reject non-allowed order in strict mode', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    expect(() => {
      sortItemsWithValidation(testItems, 'name', 'random', strictConfig);
    }).toThrow(SortValidationError);
    expect(() => {
      sortItemsWithValidation(testItems, 'name', 'random', strictConfig);
    }).toThrow('Sort order \'random\' is not allowed');
  });

  it('should reject invalid sortBy type in strict mode', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    expect(() => {
      sortItemsWithValidation(testItems, 123 as any, 'asc', strictConfig);
    }).toThrow(SortValidationError);
  });

  it('should reject invalid order type in strict mode', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    expect(() => {
      sortItemsWithValidation(testItems, 'name', 123 as any, strictConfig);
    }).toThrow(SortValidationError);
  });

  it('should allow only alphanumeric and underscore characters in field names', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    // Valid field names
    expect(() => {
      sortItemsWithValidation(testItems, 'name', 'asc', strictConfig);
    }).not.toThrow();
    expect(() => {
      sortItemsWithValidation(testItems, 'value', 'asc', strictConfig);
    }).not.toThrow();
  });

  it('should reject field names with spaces in strict mode', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    expect(() => {
      sortItemsWithValidation(testItems, 'name value', 'asc', strictConfig);
    }).toThrow(SortValidationError);
  });

  it('should reject field names with hyphens in strict mode', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    expect(() => {
      sortItemsWithValidation(testItems, 'name-value', 'asc', strictConfig);
    }).toThrow(SortValidationError);
  });

  it('should support custom allowed orders', () => {
    const ascOnlyConfig: SortConfig<TestItem> = {
      allowedFields: ['name', 'value'],
      allowedOrders: ['asc'],
      strict: false
    };
    const result = sortItemsWithValidation(testItems, 'name', 'asc', ascOnlyConfig);
    expect(result[0].name).toBe('Apple');
  });

  it('should reject custom order not in allowlist in strict mode', () => {
    const ascOnlyConfig: SortConfig<TestItem> = {
      allowedFields: ['name', 'value'],
      allowedOrders: ['asc'],
      strict: true
    };
    expect(() => {
      sortItemsWithValidation(testItems, 'name', 'desc', ascOnlyConfig);
    }).toThrow(SortValidationError);
  });

  it('should handle empty items array', () => {
    const result = sortItemsWithValidation([], 'name', 'asc', config);
    expect(result).toEqual([]);
  });

  it('should handle single item array', () => {
    const singleItem = [{ id: 1, name: 'Apple', value: 3.5 }];
    const result = sortItemsWithValidation(singleItem, 'name', 'asc', config);
    expect(result).toEqual(singleItem);
  });

  it('should sanitize field name before validation', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    // Even if the field name starts with valid characters but has invalid ones,
    // it should be rejected
    expect(() => {
      sortItemsWithValidation(testItems, 'name!', 'asc', strictConfig);
    }).toThrow(SortValidationError);
  });

  it('should provide helpful error message for invalid field', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    try {
      sortItemsWithValidation(testItems, 'invalid_field', 'asc', strictConfig);
      fail('Should have thrown SortValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(SortValidationError);
      expect((error as SortValidationError).message).toContain('invalid_field');
      expect((error as SortValidationError).message).toContain('name, value');
    }
  });

  it('should provide helpful error message for invalid order', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    try {
      sortItemsWithValidation(testItems, 'name', 'invalid_order', strictConfig);
      fail('Should have thrown SortValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(SortValidationError);
      expect((error as SortValidationError).message).toContain('invalid_order');
      expect((error as SortValidationError).message).toContain('asc, desc');
    }
  });

  it('should handle very long field names in strict mode', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    const longFieldName = 'a'.repeat(1000);
    expect(() => {
      sortItemsWithValidation(testItems, longFieldName, 'asc', strictConfig);
    }).toThrow(SortValidationError);
  });

  it('should handle unicode characters in field names (reject in strict mode)', () => {
    const strictConfig: SortConfig<TestItem> = { ...config, strict: true };
    expect(() => {
      sortItemsWithValidation(testItems, '名前', 'asc', strictConfig);
    }).toThrow(SortValidationError);
  });

  it('should handle empty string sortBy in non-strict mode', () => {
    const result = sortItemsWithValidation(testItems, '', 'asc', config);
    expect(result).toEqual(testItems);
  });

  it('should handle empty string order in non-strict mode', () => {
    const result = sortItemsWithValidation(testItems, 'name', '', config);
    expect(result).toEqual(testItems);
  });
});
