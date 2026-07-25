// aexa-frontend#141 stage 2, product decision #3: fixed RSS source list,
// ported verbatim (name/url/credibility/category/language per source) from
// Fullbloom's reference implementation
// (supabase/functions/ai-intelligence/index.ts's `RSS_SOURCES` constant, as
// of the version fetched via
// `gh api repos/YouYouLux/full-bloom-app/contents/supabase/functions/ai-intelligence/index.ts`).
// Not curated or altered here — same ~50 feeds, same category groupings.
export type RssSource = {
  name: string;
  url: string;
  credibility: number;
  category: string;
  language: string;
};

export const RSS_SOURCES: Record<string, RssSource[]> = {
  cyber_official: [
    {
      name: 'CISA Alerts (US)',
      url: 'https://www.cisa.gov/uscert/ncas/alerts.xml',
      credibility: 9.9,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'ANSSI Alertes (FR)',
      url: 'https://www.cert.ssi.gouv.fr/feed/',
      credibility: 9.8,
      category: 'cyber',
      language: 'fr',
    },
    {
      name: 'ENISA (EU)',
      url: 'https://www.enisa.europa.eu/news/enisa-news/RSS',
      credibility: 9.7,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'NCSC UK',
      url: 'https://www.ncsc.gov.uk/api/1/services/v1/report-rss-feed.xml',
      credibility: 9.7,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'BSI Germany',
      url: 'https://www.bsi.bund.de/SiteGlobals/Functions/RSSFeed/RSSNewsfeed_Presse/RSSNewsfeed_Presse_node.xml',
      credibility: 9.6,
      category: 'cyber',
      language: 'de',
    },
    {
      name: 'SANS ISC',
      url: 'https://isc.sans.edu/rssfeed.xml',
      credibility: 9.4,
      category: 'cyber',
      language: 'en',
    },
  ],
  cyber_media: [
    {
      name: 'Krebs on Security',
      url: 'https://krebsonsecurity.com/feed/',
      credibility: 9.5,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'The Hacker News',
      url: 'https://feeds.feedburner.com/TheHackersNews',
      credibility: 8.8,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'BleepingComputer',
      url: 'https://www.bleepingcomputer.com/feed/',
      credibility: 8.9,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'Dark Reading',
      url: 'https://www.darkreading.com/rss.xml',
      credibility: 8.7,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'SecurityWeek',
      url: 'https://feeds.feedburner.com/Securityweek',
      credibility: 8.8,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'Infosecurity Magazine',
      url: 'https://www.infosecurity-magazine.com/rss/news/',
      credibility: 8.3,
      category: 'cyber',
      language: 'en',
    },
  ],
  cyber_threat_intel: [
    {
      name: 'Recorded Future',
      url: 'https://www.recordedfuture.com/feed',
      credibility: 9.2,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'Mandiant Blog',
      url: 'https://www.mandiant.com/resources/blog/rss.xml',
      credibility: 9.3,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'Unit42',
      url: 'https://unit42.paloaltonetworks.com/feed/',
      credibility: 9.1,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'CrowdStrike',
      url: 'https://www.crowdstrike.com/blog/feed/',
      credibility: 9.0,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'Cisco Talos',
      url: 'https://blog.talosintelligence.com/rss',
      credibility: 9.2,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'Microsoft Security',
      url: 'https://www.microsoft.com/en-us/security/blog/feed/',
      credibility: 9.0,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'Google Project Zero',
      url: 'https://googleprojectzero.blogspot.com/feeds/posts/default',
      credibility: 9.5,
      category: 'cyber',
      language: 'en',
    },
    {
      name: 'Securelist',
      url: 'https://securelist.com/feed/',
      credibility: 8.8,
      category: 'cyber',
      language: 'en',
    },
  ],
  geopolitical: [
    {
      name: 'Reuters World',
      url: 'https://feeds.reuters.com/Reuters/worldNews',
      credibility: 9.6,
      category: 'geopolitical',
      language: 'en',
    },
    {
      name: 'BBC World',
      url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
      credibility: 9.5,
      category: 'geopolitical',
      language: 'en',
    },
    {
      name: 'Al Jazeera',
      url: 'https://www.aljazeera.com/xml/rss/all.xml',
      credibility: 8.5,
      category: 'geopolitical',
      language: 'en',
    },
    {
      name: 'Foreign Affairs',
      url: 'https://www.foreignaffairs.com/rss.xml',
      credibility: 9.4,
      category: 'geopolitical',
      language: 'en',
    },
    {
      name: 'IISS',
      url: 'https://www.iiss.org/rss',
      credibility: 9.3,
      category: 'geopolitical',
      language: 'en',
    },
  ],
  regulatory: [
    {
      name: 'EUR-Lex',
      url: 'https://eur-lex.europa.eu/EN/display-feed.html?rssId=30',
      credibility: 10.0,
      category: 'regulatory',
      language: 'en',
    },
    {
      name: 'SEC Filings',
      url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=&dateb=&owner=include&count=40&search_text=&action=getcurrent&output=atom',
      credibility: 10.0,
      category: 'regulatory',
      language: 'en',
    },
    {
      name: 'ESMA',
      url: 'https://www.esma.europa.eu/press-news/esma-news?field_press_news_type_tid=All&items_per_page=20&format=rss',
      credibility: 9.8,
      category: 'regulatory',
      language: 'en',
    },
    {
      name: 'EBA',
      url: 'https://www.eba.europa.eu/rss/all-press-releases',
      credibility: 9.8,
      category: 'regulatory',
      language: 'en',
    },
    {
      name: 'BIS',
      url: 'https://www.bis.org/doclist/all_docs.rss',
      credibility: 9.9,
      category: 'regulatory',
      language: 'en',
    },
    {
      name: 'CSSF Luxembourg',
      url: 'https://www.cssf.lu/en/rss-feed/',
      credibility: 9.7,
      category: 'regulatory',
      language: 'en',
    },
  ],
  financial: [
    {
      name: 'Bloomberg',
      url: 'https://feeds.bloomberg.com/markets/news.rss',
      credibility: 9.5,
      category: 'financial',
      language: 'en',
    },
    {
      name: 'Financial Times',
      url: 'https://www.ft.com/rss/home',
      credibility: 9.6,
      category: 'financial',
      language: 'en',
    },
    {
      name: 'WSJ Markets',
      url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
      credibility: 9.5,
      category: 'financial',
      language: 'en',
    },
    {
      name: 'Les Echos',
      url: 'https://syndication.lesechos.fr/rss/rss_une_titres.xml',
      credibility: 9.3,
      category: 'financial',
      language: 'fr',
    },
    {
      name: 'Handelsblatt',
      url: 'https://www.handelsblatt.com/contentexport/feed/top-themen',
      credibility: 9.2,
      category: 'financial',
      language: 'de',
    },
    {
      name: 'ECB Press',
      url: 'https://www.ecb.europa.eu/rss/press.html',
      credibility: 10.0,
      category: 'financial',
      language: 'en',
    },
  ],
  supply_chain: [
    {
      name: 'Supply Chain Dive',
      url: 'https://www.supplychaindive.com/feeds/news/',
      credibility: 8.5,
      category: 'supply_chain',
      language: 'en',
    },
    {
      name: 'Logistics Manager',
      url: 'https://www.logisticsmanager.com/feed/',
      credibility: 8.0,
      category: 'supply_chain',
      language: 'en',
    },
    {
      name: 'FreightWaves',
      url: 'https://www.freightwaves.com/news/rss.xml',
      credibility: 8.3,
      category: 'supply_chain',
      language: 'en',
    },
  ],
  natural_disaster: [
    {
      name: 'USGS Earthquakes',
      url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.atom',
      credibility: 10.0,
      category: 'natural_disaster',
      language: 'en',
    },
    {
      name: 'GDACS',
      url: 'https://www.gdacs.org/xml/rss.xml',
      credibility: 9.8,
      category: 'natural_disaster',
      language: 'en',
    },
    {
      name: 'ReliefWeb',
      url: 'https://reliefweb.int/updates/rss.xml',
      credibility: 9.5,
      category: 'natural_disaster',
      language: 'en',
    },
    {
      name: 'WHO Emergencies',
      url: 'https://www.who.int/feeds/entity/csr/don/en/rss.xml',
      credibility: 9.9,
      category: 'natural_disaster',
      language: 'en',
    },
  ],
  esg_climate: [
    {
      name: 'GreenBiz',
      url: 'https://www.greenbiz.com/rss/all',
      credibility: 8.2,
      category: 'esg',
      language: 'en',
    },
    {
      name: 'Carbon Brief',
      url: 'https://www.carbonbrief.org/feed/',
      credibility: 9.0,
      category: 'esg',
      language: 'en',
    },
    {
      name: 'Climate Home',
      url: 'https://www.climatechangenews.com/feed/',
      credibility: 8.5,
      category: 'esg',
      language: 'en',
    },
  ],
  technology: [
    {
      name: 'MIT Technology Review',
      url: 'https://www.technologyreview.com/feed/',
      credibility: 9.2,
      category: 'technology',
      language: 'en',
    },
    {
      name: 'Wired',
      url: 'https://www.wired.com/feed/rss',
      credibility: 8.8,
      category: 'technology',
      language: 'en',
    },
    {
      name: 'Ars Technica',
      url: 'https://feeds.arstechnica.com/arstechnica/index',
      credibility: 8.9,
      category: 'technology',
      language: 'en',
    },
    {
      name: 'TechCrunch',
      url: 'https://techcrunch.com/feed/',
      credibility: 8.5,
      category: 'technology',
      language: 'en',
    },
  ],
  commodities: [
    {
      name: 'Fastmarkets',
      url: 'https://www.fastmarkets.com/feed',
      credibility: 9.3,
      category: 'commodities',
      language: 'en',
    },
    {
      name: 'Mining.com',
      url: 'https://www.mining.com/feed/',
      credibility: 8.7,
      category: 'commodities',
      language: 'en',
    },
    {
      name: 'Platts',
      url: 'https://www.spglobal.com/commodityinsights/en/rss-feed',
      credibility: 9.5,
      category: 'commodities',
      language: 'en',
    },
  ],
};

// Flat list of every source across every category — what
// intelligence.service.ts's scrape actually iterates over. Categories exist
// in RSS_SOURCES purely as Fullbloom's original grouping/documentation; this
// stage doesn't expose a per-category scrape filter (not asked for by the
// product decisions), so it's always "scrape everything".
export const ALL_RSS_SOURCES: RssSource[] = Object.values(RSS_SOURCES).flat();
