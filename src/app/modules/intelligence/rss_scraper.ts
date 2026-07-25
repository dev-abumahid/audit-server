import { logger } from '../../lib/logger.js';
import { RssSource } from './rss_sources.js';

// Regex-based RSS/Atom parsing ported from Fullbloom's
// ai-intelligence/index.ts (`extractTag`/`extractItems`). No XML parser
// dependency exists in this codebase yet (checked package.json), and
// Fullbloom's own reference deliberately avoids one too — a full XML parser
// would choke on the malformed/non-conformant XML several of these ~50 feeds
// are known to emit, where a tolerant regex scan degrades gracefully instead.
// Decodes the handful of HTML/XML entities RSS/Atom feeds routinely emit in
// titles and descriptions (Reuters/BBC entity-encode ampersands and quotes).
// Left undecoded, titles carry literal "&amp;" text, which is both a display
// bug and widens the title-collision surface used for dedup/analyze-matching
// below (two encodings of the same punctuation would compare unequal).
//
// A SINGLE regex.replace() pass, not sequential chained replaces: chaining
// (`.replace(/&amp;/g,'&').replace(/&lt;/g,'<')...`) would re-scan a
// replacement's OWN output on the next call, so genuinely double-escaped
// input like "&amp;amp;lt;" (meant to literally display "&amp;lt;") gets
// over-decoded to "<" -- the first replace produces "&amp;lt;", which the
// next replace then decodes again. A single pass with one combined regex
// never re-scans what it just replaced (String.replace does not restart
// matching inside substituted text), so "&amp;amp;lt;" correctly decodes to
// the literal "&amp;lt;" and stops there.
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (match, entity: string) => {
    if (entity in NAMED_ENTITIES) return NAMED_ENTITIES[entity];
    if (entity[0] === '#') {
      return entity[1] === 'x' || entity[1] === 'X'
        ? String.fromCharCode(parseInt(entity.slice(2), 16))
        : String.fromCharCode(parseInt(entity.slice(1), 10));
    }
    return match;
  });
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  if (match) {
    return decodeEntities(match[1].replace(/<!\[CDATA\[|\]\]>/g, '')).trim();
  }
  // Atom's <link> is commonly self-closing (`<link rel="alternate" href="..."/>`,
  // e.g. every Blogger/Blogspot feed in RSS_SOURCES) rather than a
  // <link>...</link> pair -- the regex above never matches that form at all,
  // silently losing the real article URL for every such feed. Extract the
  // href attribute from a self-closing (or unclosed) tag as a fallback.
  const selfClosing = new RegExp(`<${tag}\\b[^>]*\\bhref=["']([^"']+)["'][^>]*/?>`, 'i');
  const selfClosingMatch = xml.match(selfClosing);
  return selfClosingMatch ? decodeEntities(selfClosingMatch[1]).trim() : '';
}

export type RawFeedItem = {
  title: string;
  description: string;
  link: string;
  pubDate: string;
};

// Caps at 15 items per feed, same as Fullbloom — an individual feed can list
// hundreds of historical entries; only the newest handful are relevant for a
// threat-intel scrape.
function extractItems(xml: string): RawFeedItem[] {
  const items: RawFeedItem[] = [];
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null && items.length < 15) {
    const block = match[1];
    items.push({
      title: extractTag(block, 'title'),
      description:
        extractTag(block, 'description') ||
        extractTag(block, 'summary') ||
        extractTag(block, 'content'),
      link: extractTag(block, 'link') || extractTag(block, 'id'),
      pubDate:
        extractTag(block, 'pubDate') ||
        extractTag(block, 'published') ||
        extractTag(block, 'updated'),
    });
  }
  return items;
}

export type ScrapedFeedItem = {
  source_name: string;
  source_category: string;
  source_credibility: number;
  source_language: string;
  title: string;
  description: string;
  link: string;
  published_at: string;
};

// Fetches and parses a single RSS/Atom feed, tolerant of that one feed
// failing (timeout, malformed XML, non-2xx, DNS failure, ...) — ported from
// Fullbloom's fetchRSSFeed: a 10s AbortController timeout per feed, and a
// catch-all that resolves to an empty array rather than throwing, so
// Promise.allSettled in scrapeAllSources never has a rejected promise to
// begin with (every individual feed failure is already absorbed here).
export async function fetchRSSFeed(source: RssSource): Promise<ScrapedFeedItem[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(source.url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'AEXA-RiskIntel/3.0',
          Accept: 'application/rss+xml, application/xml, text/xml, application/atom+xml, */*',
        },
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return [];
    const xml = await response.text();
    const items = extractItems(xml);
    return items
      .filter((item) => item.title)
      .map((item) => ({
        source_name: source.name,
        source_category: source.category,
        source_credibility: source.credibility,
        source_language: source.language,
        title: item.title.slice(0, 500),
        description: (item.description || '').replace(/<[^>]*>/g, '').slice(0, 2000),
        link: item.link,
        published_at: item.pubDate,
      }));
  } catch (error) {
    // Per-feed failure is expected and routine (dead feed, timeout, host
    // down) — logged at debug-ish level, never thrown, so one bad feed can
    // never fail the whole scrape.
    logger.warn({ err: error, source: source.name }, 'RSS feed fetch failed, skipping');
    return [];
  }
}

export type ScrapeSummary = {
  items: ScrapedFeedItem[];
  sourcesTotal: number;
  sourcesSucceeded: number;
};

// Fetches every source in parallel via Promise.allSettled (mirroring
// Fullbloom's scrape_sources action) — every individual fetchRSSFeed call
// already swallows its own errors and resolves to `[]`, so every settled
// result here is "fulfilled" in practice; allSettled is kept anyway as a
// second line of defense against an unexpected synchronous throw.
export async function scrapeAllSources(sources: RssSource[]): Promise<ScrapeSummary> {
  const results = await Promise.allSettled(sources.map((source) => fetchRSSFeed(source)));

  const items: ScrapedFeedItem[] = [];
  let sourcesSucceeded = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value.length > 0) sourcesSucceeded += 1;
      items.push(...result.value);
    }
  }

  return { items, sourcesTotal: sources.length, sourcesSucceeded };
}

// Dedupes by source_name + title (case-insensitive), same key Fullbloom
// uses. When a re-scrape sees the exact same (source, title) pair as an
// earlier run within this same in-memory batch, the higher-credibility copy
// wins (defensive — in practice both copies of a dupe within one batch come
// from the same source and have identical credibility).
export function dedupeScrapedItems(items: ScrapedFeedItem[]): ScrapedFeedItem[] {
  const deduped = new Map<string, ScrapedFeedItem>();
  for (const item of items) {
    const key = `${item.source_name.toLowerCase()}::${item.title.toLowerCase()}`;
    const current = deduped.get(key);
    if (!current || item.source_credibility > current.source_credibility) {
      deduped.set(key, item);
    }
  }
  return Array.from(deduped.values());
}
