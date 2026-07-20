import { describe, expect, it } from 'vitest';
import { constantTimeStringEqual } from '../../app/utils/secureCompare.js';

describe('constantTimeStringEqual (#109)', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeStringEqual('ABC123', 'ABC123')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(constantTimeStringEqual('ABC123', 'ABC124')).toBe(false);
  });

  it('returns false for different strings of different lengths without throwing', () => {
    expect(() => constantTimeStringEqual('A', 'ABCDEFGHIJKLMNOP')).not.toThrow();
    expect(constantTimeStringEqual('A', 'ABCDEFGHIJKLMNOP')).toBe(false);
  });

  it('returns false for empty vs non-empty input', () => {
    expect(constantTimeStringEqual('', 'ABC123')).toBe(false);
    expect(constantTimeStringEqual('ABC123', '')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(constantTimeStringEqual('', '')).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(constantTimeStringEqual('abc123', 'ABC123')).toBe(false);
  });
});
