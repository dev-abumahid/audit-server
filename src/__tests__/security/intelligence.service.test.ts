import { Prisma } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, ORG_B, makeReq } from '../helpers/makeReq.js';

// setup.ts sets AI_INTERNAL_SECRET = 'test-ai-internal-secret' before any
// config import — the exact secret mintOrgToken signs the X-Org-Token with.
const jwtDecode = (token: string) => jwt.verify(token, 'test-ai-internal-secret') as jwt.JwtPayload;

vi.mock('../../app/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    intelligenceItem: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    intelligenceRun: {
      findMany: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    risk: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    site: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    account: {
      findUnique: vi.fn(),
    },
    orgMember: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { intelligence_service } from '../../app/modules/intelligence/intelligence.service.js';

const itemDb = prisma.intelligenceItem as unknown as Record<string, ReturnType<typeof vi.fn>>;
const runDb = prisma.intelligenceRun as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskDb = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
const siteDb = prisma.site as unknown as Record<string, ReturnType<typeof vi.fn>>;
const accountDb = prisma.account as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const txFn = (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction;

const ANCHOR = ORG_A;
const ORG_ID = 'org-00000000-0000-0000-0000-000000000009';
const MEMBER_ID = 'org-member-00000000-0000-0000-0000-000000000009';

const mockMembership = (role: 'ADMIN' | 'LEAD_AUDITOR' | 'LIGHT_USER' | 'VIEWER') => {
  orgMemberDb.findUnique.mockResolvedValue({
    id: MEMBER_ID,
    organizationId: ORG_ID,
    accountId: ORG_A,
    role,
    status: 'ACTIVE',
    expiresAt: null,
  });
  organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ANCHOR });
};

function mockAiResponse(ok: boolean, body: unknown = {}, status = 502) {
  return { ok, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function feedXml(items: Array<{ title: string; description?: string; link?: string }>) {
  return `<?xml version="1.0"?><rss><channel>${items
    .map(
      (i) =>
        `<item><title>${i.title}</title><description>${i.description ?? ''}</description><link>${
          i.link ?? ''
        }</link></item>`,
    )
    .join('')}</channel></rss>`;
}

describe('intelligence service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row -- ADMIN-of-self fallback, same default every
    // other org-anchor-scoped service test file in this repo uses.
    orgMemberDb.findUnique.mockResolvedValue(null);
    accountDb.findUnique.mockResolvedValue({
      email: 'orga@test.com',
      organizationProfile: {
        organizationName: 'Acme Corp',
        sector: 'manufacturing',
        country: 'FR',
      },
    });
    riskDb.findMany.mockResolvedValue([]);
    siteDb.findMany.mockResolvedValue([]);
    txFn.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
  });

  describe('org scoping', () => {
    it('get_all_items_from_db scopes by the caller org anchor, not a hardcoded org', async () => {
      mockMembership('LEAD_AUDITOR');
      itemDb.findMany.mockResolvedValue([]);
      itemDb.count.mockResolvedValue(0);

      await intelligence_service.get_all_items_from_db(makeReq());

      const [callArg] = itemDb.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({ org_account_id: ANCHOR });
    });

    it('get_all_runs_from_db scopes by the caller org anchor', async () => {
      mockMembership('LEAD_AUDITOR');
      runDb.findMany.mockResolvedValue([]);
      runDb.count.mockResolvedValue(0);

      await intelligence_service.get_all_runs_from_db(makeReq());

      const [callArg] = runDb.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({ org_account_id: ANCHOR });
    });

    it('create_risk_from_item_into_db 404s on an item that belongs to another org', async () => {
      // Org A's caller tries to act on what would be org B's item -- the
      // findFirst is itself org-scoped, so a cross-org id resolves to null,
      // same as risk.service.ts's get_single_risk_from_db IDOR guard.
      itemDb.findFirst.mockResolvedValue(null);

      await expect(
        intelligence_service.create_risk_from_item_into_db(
          makeReq({ params: { id: 'item-owned-by-org-b' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(itemDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'item-owned-by-org-b', org_account_id: ORG_A },
      });
      expect(riskDb.create).not.toHaveBeenCalled();
      expect(ORG_B).toBeTruthy(); // sanity: constant imported and available for this scenario
    });
  });

  describe('scrape_sources_into_db — dedup', () => {
    // Only the CISA feed URL returns an item; every other one of the ~50
    // sources returns an empty channel, so the resulting candidate batch is
    // deterministic (exactly one item) instead of fanning out across every
    // source in RSS_SOURCES.
    const onlyCisaHasAnItem = (title: string, link = 'https://example.com/1') =>
      vi.fn().mockImplementation(async (url: string) => ({
        ok: true,
        text: async () => (url.includes('cisa.gov') ? feedXml([{ title, link }]) : feedXml([])),
      }));

    it('skips an item already persisted for this org (by source_name + title)', async () => {
      vi.stubGlobal('fetch', onlyCisaHasAnItem('Existing breach story'));
      // The store already has this exact (source_name, title) pair.
      itemDb.findMany.mockResolvedValue([
        { title: 'Existing breach story', source_name: 'CISA Alerts (US)', link: null },
      ]);

      const result = await intelligence_service.scrape_sources_into_db(makeReq());

      expect(itemDb.create).not.toHaveBeenCalled();
      expect(result.itemsNew).toBe(0);
    });

    it('persists a new item not already in the store', async () => {
      vi.stubGlobal('fetch', onlyCisaHasAnItem('Brand new incident', 'https://example.com/2'));
      itemDb.findMany.mockResolvedValue([]);
      itemDb.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'new-item-1',
        ...data,
      }));

      const result = await intelligence_service.scrape_sources_into_db(makeReq());

      expect(itemDb.create).toHaveBeenCalledTimes(1);
      expect(result.itemsNew).toBe(1);
      const [createCall] = itemDb.create.mock.calls[0];
      expect(createCall.data.org_account_id).toBe(ORG_A);
      expect(createCall.data.title).toBe('Brand new incident');
    });

    it('tolerates an individual feed failure without failing the whole scrape', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => {
          throw new Error('feed host unreachable');
        }),
      );
      itemDb.findMany.mockResolvedValue([]);

      const result = await intelligence_service.scrape_sources_into_db(makeReq());

      expect(result.sourcesSucceeded).toBe(0);
      expect(result.itemsNew).toBe(0);
    });
  });

  describe('analyze_items_into_db — update in place', () => {
    it('updates the existing IntelligenceItem row rather than inserting a new one', async () => {
      const existingItem = {
        id: 'item-1',
        org_account_id: ORG_A,
        title: 'Ransomware hits supplier',
        description: 'desc',
        source_name: 'Krebs on Security',
        source_category: 'cyber',
        source_credibility: 9.5,
        published_at: null,
      };
      itemDb.findMany.mockResolvedValue([existingItem]);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          mockAiResponse(true, {
            analyzed: [
              {
                original_title: 'Ransomware hits supplier',
                is_risk: true,
                severity: 'high',
                category: 'cyber',
                relevance_score: 0.8,
                risk_summary: 'A supplier was hit by ransomware',
                root_cause: 'Unpatched VPN',
                potential_impact: 'Supply disruption',
                recommended_actions: [],
                confidence: 0.7,
                source_evidence: 'Krebs article',
              },
            ],
            count: 1,
          }),
        ),
      );
      itemDb.update.mockResolvedValue({ id: 'item-1' });

      const result = await intelligence_service.analyze_items_into_db(
        makeReq({ body: { itemIds: ['item-1'] } }),
      );

      expect(itemDb.create).not.toHaveBeenCalled();
      expect(itemDb.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: expect.objectContaining({
          is_risk: true,
          severity: 'high',
          analyzed_at: expect.any(Date),
        }),
      });
      expect(result.count).toBe(1);
    });

    it('requests all un-analyzed items for the org when no itemIds are given', async () => {
      itemDb.findMany.mockResolvedValue([]);

      await intelligence_service.analyze_items_into_db(makeReq({ body: {} }));

      const [callArg] = itemDb.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({ org_account_id: ORG_A, analyzed_at: null });
    });

    it('propagates a 502 when aexa-ai is unreachable, and does not update anything', async () => {
      itemDb.findMany.mockResolvedValue([
        {
          id: 'item-1',
          org_account_id: ORG_A,
          title: 't',
          description: null,
          source_name: 's',
          source_category: null,
          source_credibility: null,
          published_at: null,
        },
      ]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockAiResponse(false, {}, 503)));

      await expect(
        intelligence_service.analyze_items_into_db(makeReq({ body: {} })),
      ).rejects.toMatchObject({ statusCode: 502 });

      expect(itemDb.update).not.toHaveBeenCalled();
    });

    it('sends only one representative item per unique title to aexa-ai, and applies that single analysis to every item sharing the title', async () => {
      // Two different sources reporting the identical story -- our scrape
      // dedup only collapses same-source/same-title duplicates, so both rows
      // are legitimately persisted. Regression test for the title-collision
      // bug: previously ALL occurrences were sent to aexa-ai and the response
      // was keyed back by title alone, so if aexa-ai's response array
      // collapsed/reordered same-titled entries, one item could silently
      // receive a DIFFERENT item's analysis. The fix dedupes by title before
      // the request and deliberately applies one shared analysis to every
      // row with that title.
      const itemA = {
        id: 'item-a',
        org_account_id: ORG_A,
        title: 'Port strike disrupts Suez traffic',
        description: 'From Reuters',
        source_name: 'Reuters World',
        source_category: 'geopolitical',
        source_credibility: 9.6,
        published_at: null,
      };
      const itemB = {
        id: 'item-b',
        org_account_id: ORG_A,
        title: 'Port strike disrupts Suez traffic',
        description: 'From BBC',
        source_name: 'BBC World',
        source_category: 'geopolitical',
        source_credibility: 9.5,
        published_at: null,
      };
      itemDb.findMany.mockResolvedValue([itemA, itemB]);
      const fetchMock = vi.fn().mockResolvedValue(
        mockAiResponse(true, {
          analyzed: [
            {
              original_title: 'Port strike disrupts Suez traffic',
              is_risk: true,
              severity: 'high',
              category: 'Supply Chain',
              relevance_score: 0.9,
              risk_summary: 'Strike disrupts shipping',
              root_cause: 'Labor dispute',
              potential_impact: 'Delayed shipments',
              recommended_actions: [],
              confidence: 0.8,
              source_evidence: null,
            },
          ],
          count: 1,
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      itemDb.update.mockResolvedValue({ id: 'updated' });

      const result = await intelligence_service.analyze_items_into_db(
        makeReq({ body: { itemIds: ['item-a', 'item-b'] } }),
      );

      // Only ONE item (the representative) went into the outbound request.
      const [, requestInit] = fetchMock.mock.calls[0];
      const sentBody = JSON.parse(requestInit.body as string);
      expect(sentBody.items).toHaveLength(1);
      expect(sentBody.items[0].title).toBe('Port strike disrupts Suez traffic');

      // But BOTH persisted rows get the (single) analysis applied.
      expect(itemDb.update).toHaveBeenCalledTimes(2);
      expect(itemDb.update).toHaveBeenCalledWith({
        where: { id: 'item-a' },
        data: expect.objectContaining({
          severity: 'high',
          risk_summary: 'Strike disrupts shipping',
        }),
      });
      expect(itemDb.update).toHaveBeenCalledWith({
        where: { id: 'item-b' },
        data: expect.objectContaining({
          severity: 'high',
          risk_summary: 'Strike disrupts shipping',
        }),
      });
      expect(result.count).toBe(2);
    });
  });

  describe('predict/mitigations/rcsa/resilience-scan — mocked aexa-ai calls', () => {
    it('predict_into_db persists an IntelligenceRun of type PREDICT', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(mockAiResponse(true, { score_7d: 1, score_30d: 2 })),
      );
      runDb.create.mockResolvedValue({ id: 'run-1', run_type: 'PREDICT' });

      await intelligence_service.predict_into_db(makeReq());

      expect(runDb.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ org_account_id: ORG_A, run_type: 'PREDICT' }),
      });
    });

    it('predict_into_db sends the shared internal secret and a signed org-identity token on the aexa-ai call (#56)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockAiResponse(true, { score_7d: 1, score_30d: 2 }));
      vi.stubGlobal('fetch', fetchMock);
      runDb.create.mockResolvedValue({ id: 'run-1', run_type: 'PREDICT' });

      await intelligence_service.predict_into_db(makeReq());

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers).toHaveProperty('X-Internal-Secret');
      expect(init.headers).toHaveProperty('X-Org-Token');
      expect(jwtDecode(init.headers['X-Org-Token']).org_account_id).toBe(ORG_A);
    });

    it('generate_mitigations_into_db persists an IntelligenceRun of type MITIGATIONS', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockAiResponse(true, { mitigations: [] })));
      runDb.create.mockResolvedValue({ id: 'run-2', run_type: 'MITIGATIONS' });

      await intelligence_service.generate_mitigations_into_db(makeReq());

      expect(runDb.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ run_type: 'MITIGATIONS' }),
      });
    });

    it('generate_rcsa_into_db persists an IntelligenceRun of type RCSA', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockAiResponse(true, { rcsa_date: 'x' })));
      runDb.create.mockResolvedValue({ id: 'run-3', run_type: 'RCSA' });

      await intelligence_service.generate_rcsa_into_db(makeReq());

      expect(runDb.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ run_type: 'RCSA' }),
      });
    });

    it('resilience_scan_into_db gathers sites and persists an IntelligenceRun of type RESILIENCE_SCAN', async () => {
      siteDb.findMany.mockResolvedValue([{ id: 's1', country: 'FR', activity: 'manufacturing' }]);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockAiResponse(true, { analysis_date: '2026-07-25' }));
      vi.stubGlobal('fetch', fetchMock);
      runDb.create.mockResolvedValue({ id: 'run-4', run_type: 'RESILIENCE_SCAN' });

      await intelligence_service.resilience_scan_into_db(makeReq());

      const [, options] = fetchMock.mock.calls[0];
      const sentBody = JSON.parse(options.body as string);
      expect(sentBody.sites).toEqual([{ id: 's1', country: 'FR', activity: 'manufacturing' }]);
      expect(runDb.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ run_type: 'RESILIENCE_SCAN' }),
      });
    });

    it('sends the shared secret header on every outbound aexa-ai call', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockAiResponse(true, {}));
      vi.stubGlobal('fetch', fetchMock);
      runDb.create.mockResolvedValue({ id: 'run-5' });

      await intelligence_service.predict_into_db(makeReq());

      const [, options] = fetchMock.mock.calls[0];
      expect(options.headers).toMatchObject({ 'X-Internal-Secret': expect.anything() });
    });
  });

  describe('create_risk_from_item_into_db — 404/409 guards', () => {
    it('404s when the item does not exist', async () => {
      itemDb.findFirst.mockResolvedValue(null);

      await expect(
        intelligence_service.create_risk_from_item_into_db(makeReq({ params: { id: 'missing' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(riskDb.create).not.toHaveBeenCalled();
    });

    it('409s when the item has not been analyzed yet', async () => {
      itemDb.findFirst.mockResolvedValue({
        id: 'item-1',
        org_account_id: ORG_A,
        analyzed_at: null,
        created_risk_id: null,
      });

      await expect(
        intelligence_service.create_risk_from_item_into_db(makeReq({ params: { id: 'item-1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(riskDb.create).not.toHaveBeenCalled();
    });

    it('409s when the item was already promoted to a Risk', async () => {
      itemDb.findFirst.mockResolvedValue({
        id: 'item-1',
        org_account_id: ORG_A,
        analyzed_at: new Date(),
        created_risk_id: 'risk-already-created',
      });

      await expect(
        intelligence_service.create_risk_from_item_into_db(makeReq({ params: { id: 'item-1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(riskDb.create).not.toHaveBeenCalled();
    });

    it('409s when the org has no sites to attach the new risk to', async () => {
      itemDb.findFirst.mockResolvedValue({
        id: 'item-1',
        org_account_id: ORG_A,
        analyzed_at: new Date(),
        created_risk_id: null,
        title: 'Some risk',
        category: 'cyber',
        severity: 'high',
        relevance_score: 0.5,
        risk_summary: 'summary',
      });
      siteDb.findFirst.mockResolvedValue(null);

      await expect(
        intelligence_service.create_risk_from_item_into_db(makeReq({ params: { id: 'item-1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(riskDb.create).not.toHaveBeenCalled();
    });

    it('creates a Risk from an analyzed item, marks provenance, and links it back', async () => {
      itemDb.findFirst.mockResolvedValue({
        id: 'item-1',
        org_account_id: ORG_A,
        analyzed_at: new Date(),
        created_risk_id: null,
        title: 'Ransomware hits supplier',
        description: 'desc',
        category: 'cyber',
        severity: 'high',
        relevance_score: 0.8,
        risk_summary: 'A supplier was hit by ransomware',
        source_evidence: 'Krebs article',
        link: null,
      });
      siteDb.findFirst.mockResolvedValue({ id: 'site-1' });
      riskDb.create.mockResolvedValue({ id: 'risk-1', name: 'Ransomware hits supplier' });
      itemDb.updateMany.mockResolvedValue({ count: 1 });

      const result = await intelligence_service.create_risk_from_item_into_db(
        makeReq({ params: { id: 'item-1' } }),
      );

      expect(riskDb.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          org_account_id: ORG_A,
          name: 'Ransomware hits supplier',
          category: 'cyber',
          ai_generated: true,
          is_edited: false,
          site_id: 'site-1',
        }),
      });
      expect(itemDb.updateMany).toHaveBeenCalledWith({
        where: { id: 'item-1', created_risk_id: null },
        data: { created_risk_id: 'risk-1' },
      });
      expect(result.id).toBe('risk-1');
    });

    // Two concurrent create-risk calls on the same item both pass the
    // pre-check (item.created_risk_id was null when each read it), but only
    // one can win the conditional claim below -- proves the TOCTOU window is
    // closed by the WHERE clause on the updateMany, not just the earlier
    // read.
    it('loses the race when another request claimed the item first inside the transaction', async () => {
      itemDb.findFirst.mockResolvedValue({
        id: 'item-1',
        org_account_id: ORG_A,
        analyzed_at: new Date(),
        created_risk_id: null,
        title: 'Ransomware hits supplier',
        category: 'cyber',
      });
      siteDb.findFirst.mockResolvedValue({ id: 'site-1' });
      riskDb.create.mockResolvedValue({ id: 'risk-1' });
      // Someone else's request already set created_risk_id between our
      // pre-check and this transaction -- the conditional updateMany matches
      // zero rows.
      itemDb.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        intelligence_service.create_risk_from_item_into_db(makeReq({ params: { id: 'item-1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    // aexa-frontend#142 review fix: unlike onboarding.service.ts's commit
    // transaction (a brand-new org no other transaction can see until it
    // commits), this Risk is created for an EXISTING, live org -- a second
    // create-risk-from-item call (or a concurrent POST /risk) for the same
    // org+category can genuinely race computeNextRiskRef's read-then-write.
    // The whole $transaction retries via retryTransactionOnRefConflict
    // rather than 500ing the loser.
    it('retries the whole transaction on a ref unique-constraint conflict and succeeds on the second attempt', async () => {
      itemDb.findFirst.mockResolvedValue({
        id: 'item-1',
        org_account_id: ORG_A,
        analyzed_at: new Date(),
        created_risk_id: null,
        title: 'Ransomware hits supplier',
        category: 'cyber',
      });
      siteDb.findFirst.mockResolvedValue({ id: 'site-1' });
      riskDb.create
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['org_account_id', 'ref'] },
          }),
        )
        .mockResolvedValueOnce({ id: 'risk-2', name: 'Ransomware hits supplier' });
      itemDb.updateMany.mockResolvedValue({ count: 1 });

      const result = await intelligence_service.create_risk_from_item_into_db(
        makeReq({ params: { id: 'item-1' } }),
      );

      expect(riskDb.create).toHaveBeenCalledTimes(2);
      expect(result.id).toBe('risk-2');
    });

    it('propagates a non-conflict error from risk creation without retrying', async () => {
      itemDb.findFirst.mockResolvedValue({
        id: 'item-1',
        org_account_id: ORG_A,
        analyzed_at: new Date(),
        created_risk_id: null,
        title: 'Ransomware hits supplier',
        category: 'cyber',
      });
      siteDb.findFirst.mockResolvedValue({ id: 'site-1' });
      riskDb.create.mockRejectedValue(new Error('db connection lost'));

      await expect(
        intelligence_service.create_risk_from_item_into_db(makeReq({ params: { id: 'item-1' } })),
      ).rejects.toThrow('db connection lost');
      expect(riskDb.create).toHaveBeenCalledTimes(1);
    });

    it('VIEWER cannot promote an item to a Risk', async () => {
      mockMembership('VIEWER');
      itemDb.findFirst.mockResolvedValue({
        id: 'item-1',
        org_account_id: ANCHOR,
        analyzed_at: new Date(),
        created_risk_id: null,
      });

      await expect(
        intelligence_service.create_risk_from_item_into_db(makeReq({ params: { id: 'item-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(itemDb.findFirst).not.toHaveBeenCalled();
      expect(riskDb.create).not.toHaveBeenCalled();
    });
  });
});
