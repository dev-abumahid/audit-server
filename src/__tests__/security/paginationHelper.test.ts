import { describe, expect, it } from 'vitest';
import { buildPaginationMeta, paginationHelper } from '../../app/utils/paginationHelper.js';

describe('paginationHelper', () => {
  it('defaults to page 1, limit 10 when nothing is provided', () => {
    expect(paginationHelper({})).toEqual({ page: 1, limit: 10, skip: 0 });
  });

  it('clamps a huge requested limit to the maximum (100)', () => {
    const result = paginationHelper({ limit: 1000000 });
    expect(result.limit).toBe(100);
  });

  it('clamps a huge requested limit passed as a string', () => {
    const result = paginationHelper({ limit: '999999' });
    expect(result.limit).toBe(100);
  });

  it('allows a limit right at the cap', () => {
    expect(paginationHelper({ limit: 100 }).limit).toBe(100);
  });

  it('still floors a negative limit to 1', () => {
    expect(paginationHelper({ limit: -5 }).limit).toBe(1);
  });

  it('treats a falsy 0 limit as "not provided" and falls back to the default of 10', () => {
    // 0 is falsy, so `Number(0) || 10` falls back to the default of 10 —
    // that's pre-existing behavior, unrelated to the cap this fix adds.
    expect(paginationHelper({ limit: 0 }).limit).toBe(10);
  });

  it('still floors page to 1', () => {
    expect(paginationHelper({ page: -3 }).page).toBe(1);
  });

  it('rounds a fractional limit down to an integer, capped at the maximum', () => {
    expect(paginationHelper({ limit: 55.9 }).limit).toBe(55);
    // 100.5 clamps to 100 first (below the cap check), then floors to 100.
    expect(paginationHelper({ limit: 100.5 }).limit).toBe(100);
  });

  it('computes skip from the clamped limit, not the requested one', () => {
    const result = paginationHelper({ page: 3, limit: 1000000 });
    // limit clamps to 100, so skip should be (3 - 1) * 100 = 200
    expect(result.skip).toBe(200);
  });

  it('keeps skip finite and non-negative for a very large page number', () => {
    const result = paginationHelper({ page: 1e15, limit: 1000000 });
    expect(result.limit).toBe(100);
    expect(result.skip).toBe(99999999999999900);
    expect(Number.isFinite(result.skip)).toBe(true);
    expect(result.skip).toBeGreaterThanOrEqual(0);
  });

  it('buildPaginationMeta attaches total to the pagination result', () => {
    const base = paginationHelper({ page: 1, limit: 10 });
    expect(buildPaginationMeta(base, 42)).toEqual({ page: 1, limit: 10, skip: 0, total: 42 });
  });
});
