import { describe, expect, it } from 'vitest';
import { SECTOR_RULES, mapActivityToSector } from '../../app/modules/risk/sector_mapper.js';
import {
  ALL_SECTOR_BENCHMARKS,
  OTHER_SECTOR_BENCHMARK,
  SECTOR_BENCHMARKS,
  getSectorBenchmark,
} from '../../app/modules/risk/sector_benchmarks.js';

describe('mapActivityToSector', () => {
  it("matches the ticket's own example activity string to Chemical (Basic)", () => {
    expect(mapActivityToSector('Industrial chemical manufacturing and storage').sector).toBe(
      'CHEMICAL_BASIC',
    );
  });

  it('is case-insensitive', () => {
    expect(mapActivityToSector('INDUSTRIAL CHEMICAL MANUFACTURING').sector).toBe('CHEMICAL_BASIC');
    expect(mapActivityToSector('hospital operations').sector).toBe('HOSPITALS_HEALTHCARE');
  });

  it('prefers a more specific rule over a broader one that also matches', () => {
    // "pharmaceutical manufacturing" contains neither "chemical" nor any
    // other broader keyword, but this checks the general ordering
    // principle: a specific healthcare match beats a generic one.
    expect(mapActivityToSector('Pharmaceutical manufacturing plant').sector).toBe('PHARMACEUTICAL');
  });

  it('falls back to OTHER_UNCLASSIFIED for unrecognized activity text, never returning null/undefined', () => {
    const result = mapActivityToSector('Artisanal umbrella repair services');
    expect(result).toEqual(OTHER_SECTOR_BENCHMARK);
  });

  it('falls back to OTHER_UNCLASSIFIED for empty/missing activity', () => {
    expect(mapActivityToSector(null)).toEqual(OTHER_SECTOR_BENCHMARK);
    expect(mapActivityToSector(undefined)).toEqual(OTHER_SECTOR_BENCHMARK);
    expect(mapActivityToSector('   ')).toEqual(OTHER_SECTOR_BENCHMARK);
  });

  // Round-1 review finding: a short keyword like METALS_MINING's 'mine '
  // (chosen with a trailing space specifically to avoid matching
  // "determine"/"examine" outright) still matched as a mid-word FRAGMENT
  // via plain String.includes, since "determine " and "examine " both
  // genuinely contain the substring "mine ". Fixed with a leading
  // word-boundary check (see mapActivityToSector's containsWordStartMatch).
  it('does not match a short keyword as a mid-word fragment (mine -> determine/examine false positive)', () => {
    expect(
      mapActivityToSector('Laboratory used to determine environmental compliance').sector,
    ).not.toBe('METALS_MINING');
    expect(
      mapActivityToSector('Facility used to examine soil samples for contaminants').sector,
    ).not.toBe('METALS_MINING');
  });

  it('still matches the keyword as a genuine standalone word', () => {
    expect(mapActivityToSector('Open-pit mine operations').sector).toBe('METALS_MINING');
    expect(mapActivityToSector('Coal mining and extraction').sector).toBe('COAL_ENERGY');
  });

  it('matches a variety of plausible real-world Site.activity strings', () => {
    expect(mapActivityToSector('Oil and gas refining').sector).toBe('OIL_GAS_INTEGRATED');
    expect(mapActivityToSector('Software development and SaaS').sector).toBe(
      'SOFTWARE_SYSTEM_APPLICATION',
    );
    expect(mapActivityToSector('Meat processing plant').sector).toBe('FOOD_PROCESSING');
    expect(mapActivityToSector('Retail grocery supermarket chain').sector).toBe(
      'RETAIL_GROCERY_FOOD',
    );
    expect(mapActivityToSector('Freight trucking and logistics').sector).toBe('TRUCKING');
    expect(mapActivityToSector('Commercial airline operations').sector).toBe('AIR_TRANSPORT');
  });
});

describe('sector_benchmarks data integrity', () => {
  it('every benchmark margin is a plausible 0-1 fraction, not an accidental percentage', () => {
    for (const b of ALL_SECTOR_BENCHMARKS) {
      expect(b.margin).toBeGreaterThanOrEqual(0);
      expect(b.margin).toBeLessThan(1);
    }
  });

  it('every sector key is unique', () => {
    const keys = ALL_SECTOR_BENCHMARKS.map((b) => b.sector);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('getSectorBenchmark resolves every declared sector key', () => {
    for (const b of SECTOR_BENCHMARKS) {
      expect(getSectorBenchmark(b.sector)).toEqual(b);
    }
  });

  it('getSectorBenchmark returns null for an unknown key', () => {
    expect(getSectorBenchmark('NOT_A_REAL_SECTOR')).toBeNull();
  });

  it('every sector_mapper.ts rule points at a real sector_benchmarks.ts entry (no dangling keyword rule)', () => {
    for (const rule of SECTOR_RULES) {
      expect(
        getSectorBenchmark(rule.sector),
        `rule for ${rule.sector} has no matching benchmark`,
      ).not.toBeNull();
    }
  });
});
