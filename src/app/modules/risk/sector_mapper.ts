/**
 * aexa-server#347 — maps a `Site.activity` free-text field (e.g. "Industrial
 * chemical manufacturing and storage", hand-typed at site creation, no
 * controlled vocabulary) to one of the sector buckets in
 * `sector_benchmarks.ts`.
 *
 * Design decision (researched for #347, documented per the ship-with-
 * review-loop Phase 1 judgment-call step): a **keyword/rule-based mapper**,
 * not an LLM call. Two reasons:
 *   1. The ticket explicitly asks to avoid adding a live LLM call into this
 *      calculation path — EBITDA-at-risk needs to be a deterministic,
 *      re-derivable number (same inputs -> same output, no external
 *      dependency, no per-call cost/latency), which is exactly what a
 *      financial-risk calculation service should be. An LLM classification
 *      would make the benchmark-selection step non-reproducible and add a
 *      new runtime dependency (aexa-ai reachability) to a core calc that
 *      has no other reason to need it.
 *   2. `Site.activity` in practice is short, human-written free text (a
 *      handful of words), which keyword matching handles well — it's
 *      closer to "classify this short label" than "understand this
 *      document", where an LLM's advantage over keywords is much smaller.
 *
 * Each rule is a set of case-insensitive substrings; if ANY substring in a
 * rule's list is found in the activity text, that rule's sector wins. Rules
 * are checked in array order, so more specific matches (e.g. "pharmaceutical"
 * before the generic "chemical") are listed first — see the ordering notes
 * inline. Falls back to `OTHER_SECTOR_BENCHMARK` when nothing matches,
 * rather than blocking the calculation or guessing — matches the ticket's
 * explicit "documented conservative fallback... rather than blocking"
 * instruction.
 */

import {
  OTHER_SECTOR_BENCHMARK,
  type SectorBenchmark,
  getSectorBenchmark,
} from './sector_benchmarks.js';

type SectorRule = {
  sector: string;
  keywords: string[];
};

// Ordered most-specific-first: a rule earlier in this list wins over a
// later, broader one when an activity string matches both (e.g.
// "pharmaceutical manufacturing" must hit PHARMACEUTICAL, not the generic
// manufacturing/chemical buckets below it).
// Exported for the data-integrity test that checks every rule's `sector`
// resolves to a real sector_benchmarks.ts entry (see that test file).
export const SECTOR_RULES: SectorRule[] = [
  {
    sector: 'PHARMACEUTICAL',
    keywords: ['pharmaceutical', 'pharma ', 'pharma,', 'drug manufactur'],
  },
  { sector: 'BIOTECHNOLOGY', keywords: ['biotech', 'biotechnology'] },
  { sector: 'HEALTHCARE_PRODUCTS', keywords: ['medical device', 'healthcare product'] },
  {
    sector: 'HOSPITALS_HEALTHCARE',
    keywords: ['hospital', 'clinic', 'healthcare facilit', 'medical center'],
  },
  { sector: 'CHEMICAL_SPECIALTY', keywords: ['specialty chemical', 'fine chemical'] },
  {
    sector: 'CHEMICAL_BASIC',
    keywords: [
      'chemical manufactur',
      'chemical storage',
      'chemical plant',
      'petrochemical',
      'chemical',
      'chimique',
    ],
  },
  {
    sector: 'OIL_GAS_PRODUCTION',
    keywords: [
      'oil exploration',
      'gas exploration',
      'oil production',
      'oil & gas production',
      'upstream oil',
    ],
  },
  {
    sector: 'OIL_GAS_INTEGRATED',
    keywords: ['oil & gas', 'oil and gas', 'petroleum', 'refinery', 'refining'],
  },
  { sector: 'COAL_ENERGY', keywords: ['coal mining', 'coal '] },
  { sector: 'METALS_MINING', keywords: ['mining', 'mine ', 'quarry', 'quarrying'] },
  { sector: 'STEEL', keywords: ['steel mill', 'steelmaking', 'steel'] },
  {
    sector: 'AEROSPACE_DEFENSE',
    keywords: ['aerospace', 'defense contractor', 'aircraft manufactur', 'defence'],
  },
  { sector: 'SHIPBUILDING_MARINE', keywords: ['shipbuilding', 'shipyard', 'marine vessel'] },
  { sector: 'AUTO_PARTS', keywords: ['auto parts', 'automotive component', 'auto component'] },
  {
    sector: 'AUTO_TRUCK',
    keywords: [
      'automotive manufactur',
      'automobile manufactur',
      'truck manufactur',
      'vehicle assembly',
      'automotive',
      'automobile',
    ],
  },
  {
    sector: 'MACHINERY',
    keywords: ['machinery manufactur', 'industrial machinery', 'heavy machinery', 'machine tool'],
  },
  { sector: 'ELECTRICAL_EQUIPMENT', keywords: ['electrical equipment', 'electrical component'] },
  { sector: 'SEMICONDUCTOR', keywords: ['semiconductor', 'chip fabrication', 'wafer fab'] },
  {
    sector: 'COMPUTERS_PERIPHERALS',
    keywords: ['computer hardware', 'electronics manufactur', 'consumer electronics'],
  },
  {
    sector: 'SOFTWARE_SYSTEM_APPLICATION',
    keywords: ['software', 'saas', 'it services', 'information technology'],
  },
  {
    sector: 'COMPUTER_SERVICES',
    keywords: ['data center', 'data centre', 'it support', 'computer services'],
  },
  {
    sector: 'TELECOM_WIRELESS',
    keywords: ['wireless carrier', 'mobile network', 'telecom wireless'],
  },
  {
    sector: 'TELECOM_SERVICES',
    keywords: ['telecommunications', 'telecom', 'internet service provider'],
  },
  { sector: 'BROADCASTING', keywords: ['broadcasting', 'television network', 'radio station'] },
  { sector: 'PUBLISHING_NEWSPAPERS', keywords: ['publishing', 'newspaper', 'print media'] },
  {
    sector: 'MEDIA_ENTERTAINMENT',
    keywords: ['entertainment', 'media production', 'film studio', 'streaming'],
  },
  { sector: 'ADVERTISING', keywords: ['advertising', 'marketing agency'] },
  {
    sector: 'BUILDING_MATERIALS',
    keywords: ['building material', 'cement', 'concrete', 'construction supplies'],
  },
  {
    sector: 'CONSTRUCTION_ENGINEERING',
    keywords: ['construction', 'civil engineering', 'engineering & construction', 'contractor'],
  },
  { sector: 'UTILITY_WATER', keywords: ['water utility', 'water treatment', 'wastewater'] },
  {
    sector: 'UTILITY_POWER',
    keywords: ['power plant', 'electric utility', 'power generation', 'electricity distribution'],
  },
  {
    sector: 'GREEN_RENEWABLE_ENERGY',
    keywords: ['renewable energy', 'solar', 'wind farm', 'wind energy', 'green energy'],
  },
  { sector: 'UTILITY_GENERAL', keywords: ['utility', 'utilities'] },
  {
    sector: 'ENVIRONMENTAL_WASTE',
    keywords: ['waste management', 'waste treatment', 'recycling', 'environmental services'],
  },
  { sector: 'PACKAGING_CONTAINER', keywords: ['packaging', 'container manufactur'] },
  {
    sector: 'PAPER_FOREST_PRODUCTS',
    keywords: ['paper mill', 'pulp', 'forestry', 'timber', 'forest product'],
  },
  { sector: 'APPAREL', keywords: ['apparel', 'clothing manufactur', 'textile', 'garment'] },
  {
    sector: 'FOOD_PROCESSING',
    keywords: [
      'food processing',
      'food manufactur',
      'food production',
      'meat processing',
      'agri-food',
    ],
  },
  {
    sector: 'BEVERAGE_ALCOHOLIC',
    keywords: ['brewery', 'winery', 'distillery', 'alcoholic beverage'],
  },
  { sector: 'BEVERAGE_SOFT', keywords: ['beverage', 'bottling', 'soft drink'] },
  { sector: 'FOOD_WHOLESALERS', keywords: ['food distribution', 'food wholesale'] },
  {
    sector: 'FARMING_AGRICULTURE',
    keywords: ['farming', 'agriculture', 'agricultural', 'livestock', 'crop production'],
  },
  { sector: 'RETAIL_GROCERY_FOOD', keywords: ['grocery', 'supermarket', 'food retail'] },
  { sector: 'RETAIL_GENERAL', keywords: ['retail store', 'retailer', 'retail'] },
  { sector: 'HOTEL_GAMING', keywords: ['hotel', 'casino', 'gaming resort', 'hospitality'] },
  { sector: 'RESTAURANT_DINING', keywords: ['restaurant', 'catering', 'food service'] },
  { sector: 'TRANSPORTATION_RAILROADS', keywords: ['railroad', 'railway'] },
  { sector: 'AIR_TRANSPORT', keywords: ['airline', 'air transport', 'airport'] },
  { sector: 'TRUCKING', keywords: ['trucking', 'freight', 'haulage'] },
  {
    sector: 'TRANSPORTATION',
    keywords: ['logistics', 'transportation', 'shipping', 'warehousing'],
  },
  {
    sector: 'REAL_ESTATE_GENERAL',
    keywords: ['real estate', 'property development', 'property management'],
  },
  { sector: 'INSURANCE_GENERAL', keywords: ['insurance'] },
  {
    sector: 'FINANCIAL_SERVICES_NONBANK',
    keywords: ['financial services', 'asset management', 'investment fund'],
  },
  { sector: 'EDUCATION', keywords: ['education', 'university', 'school', 'training institute'] },
  {
    sector: 'BUSINESS_CONSUMER_SERVICES',
    keywords: ['consulting', 'business services', 'professional services'],
  },
];

/**
 * Round-1 review finding: plain `String.includes` lets a short keyword
 * match as a mid-word FRAGMENT, not just a real word/phrase occurrence --
 * e.g. the METALS_MINING rule's `'mine '` keyword (a deliberate trailing
 * space so it doesn't also match "determine"/"examine" outright) still
 * matched inside "...used to **determine** environmental..." or
 * "laboratory to **examine** soil samples..." because `includes` doesn't
 * care that the match starts mid-word (the "mine " substring genuinely
 * occurs inside "deter-mine " and "exa-mine "). This checks a *leading*
 * word boundary -- the character immediately before the match (if any)
 * must not itself be a letter -- without requiring a TRAILING boundary,
 * which several keywords intentionally rely on as a prefix stem (e.g.
 * "manufactur" is meant to match both "manufacturing" and "manufacturer").
 * Every keyword in SECTOR_RULES is written to start at a natural word
 * boundary already (a full word or the start of one), so this is safe to
 * apply uniformly rather than special-casing just the one flagged keyword.
 */
function containsWordStartMatch(haystack: string, keyword: string): boolean {
  let fromIndex = 0;
  for (;;) {
    const index = haystack.indexOf(keyword, fromIndex);
    if (index === -1) return false;
    const charBefore = index > 0 ? haystack[index - 1] : undefined;
    if (charBefore == null || !/[a-z]/.test(charBefore)) return true;
    fromIndex = index + 1;
  }
}

/**
 * Maps a Site.activity free-text string to a sector benchmark. Never
 * returns null: falls back to `OTHER_SECTOR_BENCHMARK` for empty/unmatched
 * input rather than blocking the EBITDA-at-risk calculation.
 */
export function mapActivityToSector(activity: string | null | undefined): SectorBenchmark {
  if (!activity || !activity.trim()) return OTHER_SECTOR_BENCHMARK;
  const normalized = activity.toLowerCase();
  for (const rule of SECTOR_RULES) {
    if (rule.keywords.some((kw) => containsWordStartMatch(normalized, kw))) {
      // Rule sectors are always valid keys in sector_benchmarks.ts (guarded
      // by the unit test that checks every SECTOR_RULES.sector resolves) --
      // the ?? fallback here is just defensive, not an expected path.
      return getSectorBenchmark(rule.sector) ?? OTHER_SECTOR_BENCHMARK;
    }
  }
  return OTHER_SECTOR_BENCHMARK;
}
