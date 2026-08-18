/**
 * aexa-server#347 — static sector-benchmark EBITDA-margin table.
 *
 * Source: Aswath Damodaran (NYU Stern), "EBITDA/Sales Margins by Industry"
 * (https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/margin.html),
 * data date **January 2026**. This is exactly the first source the CEO's
 * ticket (#347) listed ("Damodaran (NYU Stern), S&P Capital IQ, Bloomberg,
 * Orbis/Bureau van Dijk, fédérations professionnelles, Eurostat/INSEE") and
 * the only one of those that's freely published — S&P Capital IQ, Bloomberg
 * and Orbis/BvD all require a paid license, which is a real spend decision
 * only Omar can make (see #347's scope note). Eurostat/INSEE publish
 * sector-level financial ratios too, but not a single normalized worldwide
 * EBITDA-margin-by-industry table the way Damodaran's page does, so it
 * wasn't used as the seed source tonight.
 *
 * This is a **static, hardcoded snapshot**, not a live feed — Damodaran
 * republishes this dataset roughly annually (in January), so refreshing it
 * is a periodic manual update (re-run the same WebFetch against the same
 * URL, update SNAPSHOT_DATE and the margins below), not a runtime
 * dependency. Deliberately NOT modeled as a Prisma table tonight: there's no
 * per-tenant customization or admin-editable UI need yet, so a plain
 * versioned TS module is the lowest-risk way to ship real data without an
 * extra migration (and without touching prisma/schema/ files that sibling
 * overnight tickets #345/#346 are also editing tonight). If the CEO wants
 * benchmarks editable from the UI later, this is the natural seed for a
 * migration to a real SectorBenchmark table.
 *
 * `margin` is the EBITDA/Sales ratio as a 0-1 fraction (Damodaran publishes
 * it as a percentage; divided by 100 here so call sites never have to
 * remember which scale a given number is in).
 */

export const SECTOR_BENCHMARK_SNAPSHOT_DATE = '2026-01';
export const SECTOR_BENCHMARK_SOURCE =
  'Damodaran (NYU Stern) — EBITDA/Sales Margins by Industry, data date 2026-01';

export type SectorBenchmark = {
  /** Stable machine key — persisted on Risk.ebitda_benchmark_sector. */
  sector: string;
  /** Human-readable label, matches Damodaran's own industry name. */
  label: string;
  /** EBITDA/Sales as a 0-1 fraction (e.g. 0.1234 for 12.34%). */
  margin: number;
};

/**
 * A representative subset of Damodaran's ~90-industry table, narrowed to
 * sectors plausible for aexa's GRC customers (industrial/corporate risk
 * management — not e.g. individual REIT sub-types or bank-specific rows,
 * which use different — often EBITDA-margin-meaningless, see Bank/Brokerage
 * 0.00% below — financial statement conventions entirely). Ordered roughly
 * by how likely `mapActivityToSector` is to need to disambiguate between
 * neighboring entries (see that function's own ordering comment).
 */
export const SECTOR_BENCHMARKS: SectorBenchmark[] = [
  { sector: 'CHEMICAL_BASIC', label: 'Chemical (Basic)', margin: 0.1234 },
  { sector: 'CHEMICAL_SPECIALTY', label: 'Chemical (Specialty)', margin: 0.1801 },
  { sector: 'OIL_GAS_PRODUCTION', label: 'Oil/Gas (Production and Exploration)', margin: 0.4321 },
  { sector: 'OIL_GAS_INTEGRATED', label: 'Oil/Gas (Integrated)', margin: 0.2167 },
  { sector: 'METALS_MINING', label: 'Metals & Mining', margin: 0.2936 },
  { sector: 'STEEL', label: 'Steel', margin: 0.1058 },
  { sector: 'CONSTRUCTION_ENGINEERING', label: 'Engineering/Construction', margin: 0.0796 },
  { sector: 'BUILDING_MATERIALS', label: 'Building Materials', margin: 0.1732 },
  { sector: 'MACHINERY', label: 'Machinery', margin: 0.1962 },
  { sector: 'ELECTRICAL_EQUIPMENT', label: 'Electrical Equipment', margin: 0.1265 },
  { sector: 'AUTO_TRUCK', label: 'Auto & Truck', margin: 0.0749 },
  { sector: 'AUTO_PARTS', label: 'Auto Parts', margin: 0.0904 },
  { sector: 'AEROSPACE_DEFENSE', label: 'Aerospace/Defense', margin: 0.1069 },
  { sector: 'SHIPBUILDING_MARINE', label: 'Shipbuilding & Marine', margin: 0.2041 },
  { sector: 'PHARMACEUTICAL', label: 'Drugs (Pharmaceutical)', margin: 0.3359 },
  { sector: 'BIOTECHNOLOGY', label: 'Drugs (Biotechnology)', margin: 0.1538 },
  { sector: 'HEALTHCARE_PRODUCTS', label: 'Healthcare Products', margin: 0.2034 },
  { sector: 'HOSPITALS_HEALTHCARE', label: 'Hospitals/Healthcare Facilities', margin: 0.158 },
  { sector: 'FOOD_PROCESSING', label: 'Food Processing', margin: 0.1525 },
  { sector: 'FOOD_WHOLESALERS', label: 'Food Wholesalers', margin: 0.0371 },
  { sector: 'BEVERAGE_ALCOHOLIC', label: 'Beverage (Alcoholic)', margin: 0.2952 },
  { sector: 'BEVERAGE_SOFT', label: 'Beverage (Soft)', margin: 0.2278 },
  { sector: 'FARMING_AGRICULTURE', label: 'Farming/Agriculture', margin: 0.0804 },
  { sector: 'APPAREL', label: 'Apparel', margin: 0.1147 },
  { sector: 'PACKAGING_CONTAINER', label: 'Packaging & Container', margin: 0.1436 },
  { sector: 'PAPER_FOREST_PRODUCTS', label: 'Paper/Forest Products', margin: 0.1465 },
  { sector: 'ENVIRONMENTAL_WASTE', label: 'Environmental & Waste Services', margin: 0.2099 },
  { sector: 'UTILITY_POWER', label: 'Power', margin: 0.3533 },
  { sector: 'UTILITY_WATER', label: 'Utility (Water)', margin: 0.4573 },
  { sector: 'UTILITY_GENERAL', label: 'Utility (General)', margin: 0.3492 },
  { sector: 'TELECOM_SERVICES', label: 'Telecom. Services', margin: 0.347 },
  { sector: 'TELECOM_WIRELESS', label: 'Telecom (Wireless)', margin: 0.3457 },
  {
    sector: 'SOFTWARE_SYSTEM_APPLICATION',
    label: 'Software (System & Application)',
    margin: 0.3593,
  },
  { sector: 'COMPUTER_SERVICES', label: 'Computer Services', margin: 0.0898 },
  { sector: 'SEMICONDUCTOR', label: 'Semiconductor', margin: 0.3677 },
  { sector: 'COMPUTERS_PERIPHERALS', label: 'Computers/Peripherals', margin: 0.2532 },
  { sector: 'TRANSPORTATION', label: 'Transportation', margin: 0.0983 },
  { sector: 'TRANSPORTATION_RAILROADS', label: 'Transportation (Railroads)', margin: 0.4919 },
  { sector: 'AIR_TRANSPORT', label: 'Air Transport', margin: 0.1027 },
  { sector: 'TRUCKING', label: 'Trucking', margin: 0.1558 },
  { sector: 'RETAIL_GENERAL', label: 'Retail (General)', margin: 0.1011 },
  { sector: 'RETAIL_GROCERY_FOOD', label: 'Retail (Grocery and Food)', margin: 0.054 },
  { sector: 'HOTEL_GAMING', label: 'Hotel/Gaming', margin: 0.2445 },
  { sector: 'RESTAURANT_DINING', label: 'Restaurant/Dining', margin: 0.1947 },
  { sector: 'REAL_ESTATE_GENERAL', label: 'Real Estate (General/Diversified)', margin: 0.2719 },
  {
    sector: 'FINANCIAL_SERVICES_NONBANK',
    label: 'Financial Svcs. (Non-bank & Insurance)',
    margin: 0.2102,
  },
  { sector: 'INSURANCE_GENERAL', label: 'Insurance (General)', margin: 0.2357 },
  { sector: 'BUSINESS_CONSUMER_SERVICES', label: 'Business & Consumer Services', margin: 0.1565 },
  { sector: 'EDUCATION', label: 'Education', margin: 0.1657 },
  { sector: 'MEDIA_ENTERTAINMENT', label: 'Entertainment', margin: 0.1777 },
  { sector: 'BROADCASTING', label: 'Broadcasting', margin: 0.1821 },
  { sector: 'PUBLISHING_NEWSPAPERS', label: 'Publishing & Newspapers', margin: 0.1318 },
  { sector: 'ADVERTISING', label: 'Advertising', margin: 0.1406 },
  { sector: 'COAL_ENERGY', label: 'Coal & Related Energy', margin: 0.1304 },
  { sector: 'GREEN_RENEWABLE_ENERGY', label: 'Green & Renewable Energy', margin: 0.5845 },
];

/**
 * Fallback bucket for a `Site.activity` string that doesn't match any
 * keyword rule below. Uses Damodaran's own "Total Market (without
 * financials)" aggregate — deliberately conservative in the sense of being
 * the broadest, least-assumption-laden figure available (an unweighted
 * industrial/consumer market average) rather than picking any single named
 * sector's margin, which would silently overstate confidence in a
 * classification that didn't actually match. "Without financials" (17.42%)
 * is used over the plain "Total Market" (16.56%) since financials
 * (bank/brokerage/insurance) skew the all-industry number and aexa's
 * customer base is overwhelmingly non-financial industrial/corporate sites.
 */
export const OTHER_SECTOR_BENCHMARK: SectorBenchmark = {
  sector: 'OTHER_UNCLASSIFIED',
  label: 'Other/Unclassified (Total Market ex. financials)',
  margin: 0.1742,
};

export const ALL_SECTOR_BENCHMARKS: SectorBenchmark[] = [
  ...SECTOR_BENCHMARKS,
  OTHER_SECTOR_BENCHMARK,
];

const benchmarksBySector = new Map(ALL_SECTOR_BENCHMARKS.map((b) => [b.sector, b]));

/** Looks up a benchmark row by its stable `sector` key, or null if unknown (e.g. a stale value from before this table changed). */
export function getSectorBenchmark(sector: string): SectorBenchmark | null {
  return benchmarksBySector.get(sector) ?? null;
}
