import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  dedupeScrapedItems,
  fetchRSSFeed,
  ScrapedFeedItem,
} from '../../app/modules/intelligence/rss_scraper.js';

const SOURCE = {
  name: 'Test Source',
  url: 'https://example.com/feed',
  credibility: 9.0,
  category: 'cyber',
  language: 'en',
};

function mockFetchOnce(xml: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      text: async () => xml,
    }),
  );
}

describe('rss_scraper', () => {
  it('parses a self-closing Atom <link href="..."/> element (e.g. Blogger/Blogspot feeds)', async () => {
    // Google Project Zero's feed (in RSS_SOURCES) is exactly this format --
    // a <link>...</link> PAIR never appears, only a self-closing element.
    // Before the fix, extractTag's regex required an explicit closing tag
    // and silently returned '' for every such feed, losing the article URL.
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Zero-day found in widely used library</title>
          <link rel="alternate" type="text/html" href="https://example.com/article-1"/>
          <summary>A summary</summary>
          <published>2026-07-20T00:00:00Z</published>
        </entry>
      </feed>`;
    mockFetchOnce(xml);

    const items = await fetchRSSFeed(SOURCE);

    expect(items).toHaveLength(1);
    expect(items[0].link).toBe('https://example.com/article-1');
  });

  it('decodes common HTML entities in titles and descriptions', async () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item>
        <title>Company &amp; Partner sign deal &quot;worth billions&quot;</title>
        <description>It&#39;s a &lt;major&gt; deal</description>
        <link>https://example.com/article-2</link>
      </item>
    </channel></rss>`;
    mockFetchOnce(xml);

    const items = await fetchRSSFeed(SOURCE);

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Company & Partner sign deal "worth billions"');
    // description also strips HTML tags (existing behavior) after entities
    // are decoded, so the escaped angle brackets don't get treated as tags.
    expect(items[0].description).toContain("It's a");
  });

  it('does not over-decode genuinely double-escaped entities in a single pass', async () => {
    // "&amp;amp;lt;" is a feed literally trying to display the text
    // "&amp;lt;" (double-escaped, as some CMSes do). A sequential
    // chained-replace implementation would decode &amp; first (producing
    // "&amp;lt;"), then re-scan and decode THAT &lt; too, over-decoding to
    // "<". A correct single-pass decode stops after one substitution per
    // occurrence and leaves the literal "&amp;lt;" text intact.
    const xml = `<?xml version="1.0"?><rss><channel>
      <item>
        <title>Escaped text: &amp;amp;lt;tag&amp;amp;gt;</title>
        <link>https://example.com/double-escaped</link>
      </item>
    </channel></rss>`;
    mockFetchOnce(xml);

    const items = await fetchRSSFeed(SOURCE);

    expect(items[0].title).toBe('Escaped text: &amp;lt;tag&amp;gt;');
  });

  it('still parses standard RSS <link>url</link> pairs unaffected by the self-closing fallback', async () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item>
        <title>Standard RSS item</title>
        <link>https://example.com/standard</link>
        <description>desc</description>
      </item>
    </channel></rss>`;
    mockFetchOnce(xml);

    const items = await fetchRSSFeed(SOURCE);

    expect(items[0].link).toBe('https://example.com/standard');
  });

  it('dedupeScrapedItems keeps the higher-credibility copy for an identical source+title pair', () => {
    const low: ScrapedFeedItem = {
      source_name: 'Reuters World',
      source_category: 'geopolitical',
      source_credibility: 8.0,
      source_language: 'en',
      title: 'Same story',
      description: 'v1',
      link: 'https://example.com/1',
      published_at: '',
    };
    const high: ScrapedFeedItem = { ...low, source_credibility: 9.6, description: 'v2' };

    const result = dedupeScrapedItems([low, high]);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('v2');
  });
});
