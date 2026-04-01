import { encodeHtml } from './encode';

describe('Encode Utility', () => {
  it('should encode HTML entities', () => {
    const input = '<script>alert("xss")</script>';
    const output = encodeHtml(input);
    expect(output).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('should handle single quotes and ampersands', () => {
    const input = 'Tom & Jerry\'s "Adventures"';
    const output = encodeHtml(input);
    expect(output).toBe('Tom &amp; Jerry&#x27;s &quot;Adventures&quot;');
  });

  it('should return empty string for null or undefined', () => {
    expect(encodeHtml(null as any)).toBe('');
    expect(encodeHtml(undefined as any)).toBe('');
    expect(encodeHtml('')).toBe('');
  });

  it('should return unchanged string if no unsafe characters', () => {
    const input = 'Hello World 123';
    expect(encodeHtml(input)).toBe(input);
  });
});
