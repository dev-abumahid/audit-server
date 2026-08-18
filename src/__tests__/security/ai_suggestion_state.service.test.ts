import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, ORG_B, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    site: { findUnique: vi.fn() },
    aiSuggestionState: { upsert: vi.fn(), findMany: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import {
  ai_suggestion_service,
  buildSuggestionFingerprint,
} from '../../app/modules/aiSuggestion/aiSuggestion.service.js';

const siteDb = prisma.site as unknown as Record<string, ReturnType<typeof vi.fn>>;
const stateDb = prisma.aiSuggestionState as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;

// Same pattern as ai.service.test.ts's mockMembership: simulates a real
// (non-ADMIN-of-self-fallback) OrgMember row so read-vs-write role gating
// can actually be exercised.
const ORG_ID = 'org-00000000-0000-0000-0000-000000000009';
const mockMembership = (role: 'ADMIN' | 'LEAD_AUDITOR' | 'LIGHT_USER' | 'VIEWER') => {
  orgMemberDb.findUnique.mockResolvedValue({
    id: 'org-member-1',
    organizationId: ORG_ID,
    accountId: ORG_A,
    role,
    status: 'ACTIVE',
    expiresAt: null,
  });
  organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ORG_A });
};

const suggestion = {
  risk_id: 'r1',
  title: '  Vendor Risk  ',
  description: 'Single supplier dependency',
  category: 'Operational',
  site: 'Lyon Plant',
  inherent_risk_score: 'High',
  residual_risk_score: 'Medium',
  Probability: 0.6,
  minimum_Impact: '€500K',
  maximum_impact: '€2M',
  Velocity: 'fast',
  Trend: 'increasing',
  Responsable: 'Supply Chain Manager',
  score: 14,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no OrgMember row -> ADMIN-of-self fallback (org anchor === the
  // caller's own accountId), same convention as ai.service.test.ts.
  orgMemberDb.findUnique.mockResolvedValue(null);
  siteDb.findUnique.mockResolvedValue({ id: 'site-1', org_account_id: ORG_A });
});

describe('buildSuggestionFingerprint', () => {
  it('is case- and whitespace-insensitive', () => {
    const a = buildSuggestionFingerprint('  Vendor Risk  ', 'Operational');
    const b = buildSuggestionFingerprint('vendor risk', 'operational');
    expect(a).toBe(b);
  });

  it('collapses internal whitespace runs to a single space', () => {
    const a = buildSuggestionFingerprint('Vendor   Risk', 'Operational');
    const b = buildSuggestionFingerprint('vendor risk', 'operational');
    expect(a).toBe(b);
  });

  it('produces a different fingerprint for a genuinely different title/category', () => {
    const a = buildSuggestionFingerprint('Vendor Risk', 'Operational');
    const b = buildSuggestionFingerprint('Cyber Risk', 'Technology');
    expect(a).not.toBe(b);
  });

  // Found in review: joining title/category with "::" without escaping a
  // literal "::" inside either field lets two genuinely different pairs
  // collide -- title="A::B"/category="C" and title="A"/category="B::C"
  // would otherwise both normalize to "a::b::c".
  it('does not collide when a literal "::" inside title/category would otherwise straddle the join point', () => {
    const a = buildSuggestionFingerprint('A::B', 'C');
    const b = buildSuggestionFingerprint('A', 'B::C');
    expect(a).not.toBe(b);
  });
});

describe('ai_suggestion_service.dismiss_suggestion', () => {
  // Unlike the read endpoint above, dismiss/mark-imported are mutations and
  // must stay behind assertCanWriteOrgResource -- this pins that down so
  // the read-vs-write split fixed above can't accidentally widen into "no
  // permission check anywhere."
  it('403s a VIEWER (write permission still required) and never upserts', async () => {
    mockMembership('VIEWER');

    await expect(
      ai_suggestion_service.dismiss_suggestion(makeReq({ body: { siteId: 'site-1', suggestion } })),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(stateDb.upsert).not.toHaveBeenCalled();
  });

  it('creates a row with status DISMISSED and the correct fingerprint', async () => {
    stateDb.upsert.mockResolvedValue({ id: 'state-1', status: 'DISMISSED' });

    await ai_suggestion_service.dismiss_suggestion(
      makeReq({ body: { siteId: 'site-1', suggestion } }),
    );

    const fingerprint = buildSuggestionFingerprint(suggestion.title, suggestion.category);
    expect(stateDb.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { siteId_fingerprint: { siteId: 'site-1', fingerprint } },
        create: expect.objectContaining({
          siteId: 'site-1',
          orgAccountId: ORG_A,
          fingerprint,
          title: suggestion.title,
          category: suggestion.category,
          status: 'DISMISSED',
          actedById: ORG_A,
        }),
        update: expect.objectContaining({ status: 'DISMISSED' }),
      }),
    );
  });

  it('upserts (does not create a duplicate) when dismissing the same siteId/title/category twice', async () => {
    stateDb.upsert.mockResolvedValue({ id: 'state-1', status: 'DISMISSED' });

    await ai_suggestion_service.dismiss_suggestion(
      makeReq({ body: { siteId: 'site-1', suggestion } }),
    );
    await ai_suggestion_service.dismiss_suggestion(
      makeReq({ body: { siteId: 'site-1', suggestion } }),
    );

    expect(stateDb.upsert).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = stateDb.upsert.mock.calls;
    expect(firstCall[0].where).toEqual(secondCall[0].where);
    // Both calls hit the same upsert key -- no separate `create` call is ever
    // made, so the underlying table never accumulates a duplicate row for
    // repeated dismissals of the same suggestion.
    expect(secondCall[0].update).toEqual(
      expect.objectContaining({ status: 'DISMISSED', actedAt: expect.any(Date) }),
    );
  });

  it('404s and never upserts when the site does not belong to the caller org', async () => {
    siteDb.findUnique.mockResolvedValue(null);

    await expect(
      ai_suggestion_service.dismiss_suggestion(
        makeReq({ body: { siteId: 'org-b-site', suggestion } }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(siteDb.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-b-site', org_account_id: ORG_A },
    });
    expect(stateDb.upsert).not.toHaveBeenCalled();
  });
});

describe('ai_suggestion_service.mark_suggestion_imported', () => {
  it('transitions a previously-dismissed row to IMPORTED via the same upsert key (re-import after dismiss)', async () => {
    stateDb.upsert.mockResolvedValue({ id: 'state-1', status: 'IMPORTED' });

    await ai_suggestion_service.mark_suggestion_imported(
      makeReq({ body: { siteId: 'site-1', suggestion } }),
    );

    const fingerprint = buildSuggestionFingerprint(suggestion.title, suggestion.category);
    expect(stateDb.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { siteId_fingerprint: { siteId: 'site-1', fingerprint } },
        update: expect.objectContaining({ status: 'IMPORTED' }),
        create: expect.objectContaining({ status: 'IMPORTED' }),
      }),
    );
  });
});

describe('ai_suggestion_service.get_site_suggestion_states', () => {
  it('returns rows for the requested site (already org-verified via the site lookup), ordered by actedAt desc', async () => {
    stateDb.findMany.mockResolvedValue([{ id: 'state-1' }, { id: 'state-2' }]);

    const result = await ai_suggestion_service.get_site_suggestion_states(
      makeReq({ params: { siteId: 'site-1' } }),
    );

    expect(siteDb.findUnique).toHaveBeenCalledWith({
      where: { id: 'site-1', org_account_id: ORG_A },
    });
    expect(stateDb.findMany).toHaveBeenCalledWith({
      where: { siteId: 'site-1' },
      orderBy: { actedAt: 'desc' },
    });
    expect(result).toHaveLength(2);
  });

  it('404s for a site belonging to a different org, mirroring the site lookup pattern, and never queries suggestion state', async () => {
    siteDb.findUnique.mockResolvedValue(null);

    await expect(
      ai_suggestion_service.get_site_suggestion_states(makeReq({ params: { siteId: ORG_B } })),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(stateDb.findMany).not.toHaveBeenCalled();
  });

  // Found in review: this endpoint originally shared its site-lookup helper
  // with the write endpoints below, which also asserted write permission --
  // silently 403ing VIEWER/LIGHT_USER roles out of a pure read (viewing
  // dismissed-suggestion history), even though those roles can see
  // everything else about the site. Fixed by giving reads their own
  // permission-free lookup (resolveCallerAndSiteForRead); these two cases
  // pin that down so it can't regress silently the way it shipped the
  // first time.
  it.each(['VIEWER', 'LIGHT_USER'] as const)(
    "%s can read a site's suggestion-state history (read, not gated by write permission)",
    async (role) => {
      mockMembership(role);
      stateDb.findMany.mockResolvedValue([{ id: 'state-1' }]);

      const result = await ai_suggestion_service.get_site_suggestion_states(
        makeReq({ params: { siteId: 'site-1' } }),
      );

      expect(result).toHaveLength(1);
    },
  );
});
