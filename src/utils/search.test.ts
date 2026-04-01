import { searchItems } from '../utils/search';

interface TestItem {
  id: number;
  name: string;
  description: string;
}

const testItems: TestItem[] = [
  { id: 1, name: 'Apple', description: 'A red fruit' },
  { id: 2, name: 'Banana', description: 'A yellow fruit' },
  { id: 3, name: 'Cherry', description: 'A small red fruit' },
];

describe('searchItems', () => {
  it('should return all items when query is empty', () => {
    const result = searchItems(testItems, '', ['name', 'description']);
    expect(result).toHaveLength(3);
  });

  it('should filter items by name (case-insensitive)', () => {
    const result = searchItems(testItems, 'apple', ['name']);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Apple');
  });

  it('should filter items by description', () => {
    const result = searchItems(testItems, 'yellow', ['description']);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Banana');
  });

  it('should search across multiple fields', () => {
    const result = searchItems(testItems, 'red', ['name', 'description']);
    expect(result).toHaveLength(2); // Apple and Cherry
  });

  it('should return empty array when no matches found', () => {
    const result = searchItems(testItems, 'grape', ['name']);
    expect(result).toHaveLength(0);
  });

  it('should ignore non-string fields', () => {
    const itemsWithNumbers = [
      { id: 1, name: 'Apple', code: 123 },
      { id: 2, name: 'Banana', code: 456 },
    ];
    // @ts-ignore
    const result = searchItems(itemsWithNumbers, '123', ['code']);
    expect(result).toHaveLength(0);
  });
});
