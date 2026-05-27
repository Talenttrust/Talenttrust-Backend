import { sortItems } from '../utils/sorting';

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
