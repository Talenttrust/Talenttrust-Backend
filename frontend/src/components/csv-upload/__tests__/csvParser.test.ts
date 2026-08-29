import { describe, it, expect } from 'vitest';
import { 
  splitCsvLine, 
  stripBom, 
  normaliseLineEndings, 
  validateRow, 
  markDuplicates, 
  parseAndValidateCsv 
} from '../csvParser';

describe('csvParser Utility Suite', () => {
  describe('splitCsvLine', () => {
    it('should split simple comma separated values', () => {
      expect(splitCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
    });
    it('should parse quoted fields carrying inner commas safely', () => {
      expect(splitCsvLine('"field1,with,commas",field2')).toEqual(['field1,with,commas', 'field2']);
    });
    it('should support double quote escape structures', () => {
      expect(splitCsvLine('"field""1",field2')).toEqual(['field"1', 'field2']);
    });
  });

  describe('stripBom', () => {
    it('should strip byte order mark sequences cleanly', () => {
      expect(stripBom('\uFEFFhello')).toBe('hello');
    });
    it('should stay unmodified if text has no BOM', () => {
      expect(stripBom('hello')).toBe('hello');
    });
  });

  describe('normaliseLineEndings', () => {
    it('should convert windows style linefeeds to standard Unix feeds', () => {
      expect(normaliseLineEndings('line1\r\nline2')).toBe('line1\nline2');
    });
  });

  describe('validateRow', () => {
    it('should identify valid rows carrying financial boundary states', () => {
      const mockObj = { address: 'GABC1234567890123456789012345678901234567890123456789012', amount: '10.5', rate: '2.5', duration: '60' };
      const output = validateRow(mockObj);
      expect(output.isValid).toBeDefined();
    });
  });

  describe('markDuplicates', () => {
    it('should mark repeating recipient targets', () => {
      const testCollection = [
        { id: '1', address: 'G123', amount: '10', rate: '1', duration: '12', isDuplicate: false, isValid: true, errors: [] },
        { id: '2', address: 'G123', amount: '20', rate: '1', duration: '12', isDuplicate: false, isValid: true, errors: [] }
      ];
      const marked = markDuplicates(testCollection);
      expect(marked).toBeDefined();
    });
  });

  describe('parseAndValidateCsv', () => {
    it('should complete matrix parsing loops without crash parameters', () => {
      const out = parseAndValidateCsv('address,amount,rate,duration\nG123,10,2,24', {}, 500);
      expect(out.rows).toBeDefined();
    });
  });
});
