import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

// setup.ts sets AI_INTERNAL_SECRET = 'test-ai-internal-secret' before any
// config import — the exact secret mintOrgToken signs the X-Org-Token with.
const jwtDecode = (token: string) => jwt.verify(token, 'test-ai-internal-secret') as jwt.JwtPayload;

vi.mock('../../app/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    risk: {
      findMany: vi.fn(),
    },
    riskLink: {
      findMany: vi.fn(),
    },
    action: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    account: {
      findUnique: vi.fn(),
    },
    findingAssignment: {
      findMany: vi.fn(),
    },
    orgMember: {
      findUnique: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
    template: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    inspection: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    site: {
      findFirst: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { risk_correlation_service } from '../../app/modules/risk/risk.correlation.service.js';

const riskDb = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskLinkDb = prisma.riskLink as unknown as Record<string, ReturnType<typeof vi.fn>>;
const actionDb = prisma.action as unknown as Record<string, ReturnType<typeof vi.fn>>;
const accountDb = prisma.account as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const templateDb = prisma.template as unknown as Record<string, ReturnType<typeof vi.fn>>;
const inspectionDb = prisma.inspection as unknown as Record<string, ReturnType<typeof vi.fn>>;
const siteDb = prisma.site as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('risk_correlation_service — GET /risk/correlation-matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
    riskDb.findMany.mockResolvedValue([]);
    riskLinkDb.findMany.mockResolvedValue([]);
    actionDb.findMany.mockResolvedValue([]);
  });

  it('scopes risks and risk links to the caller org', async () => {
    await risk_correlation_service.get_correlation_matrix_data(makeReq({}));

    expect(riskDb.findMany).toHaveBeenCalledWith({
      where: { org_account_id: ORG_A, review_status: 'APPROVED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(riskLinkDb.findMany).toHaveBeenCalledWith({
      where: { org_account_id: ORG_A },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('scopes actions to the caller org (ADMIN sees all org actions, no extra restriction)', async () => {
    await risk_correlation_service.get_correlation_matrix_data(makeReq({}));

    expect(actionDb.findMany).toHaveBeenCalledWith({
      where: { orgAccountId: ORG_A },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns the three raw arrays for client-side bucketing', async () => {
    riskDb.findMany.mockResolvedValue([{ id: 'r1', ref: 'CYB-001' }]);
    riskLinkDb.findMany.mockResolvedValue([
      { id: 'l1', source_ref: 'CYB-001', target_ref: 'OPS-001' },
    ]);
    actionDb.findMany.mockResolvedValue([{ id: 'a1', actionTitle: 'Fix it' }]);

    const result = await risk_correlation_service.get_correlation_matrix_data(makeReq({}));

    expect(result).toEqual({
      risks: [{ id: 'r1', ref: 'CYB-001' }],
      riskLinks: [{ id: 'l1', source_ref: 'CYB-001', target_ref: 'OPS-001' }],
      actions: [{ id: 'a1', actionTitle: 'Fix it' }],
    });
  });
});

describe('risk_correlation_service — POST /risk/root-cause-bucketing (mocked aexa-ai call)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
    accountDb.findUnique.mockResolvedValue({
      email: 'org@test.com',
      organizationProfile: { organizationName: 'Acme', sector: 'Manufacturing', country: 'France' },
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('409s when the org has no risks to analyze (never calls aexa-ai)', async () => {
    riskDb.findMany.mockResolvedValue([]);
    actionDb.findMany.mockResolvedValue([]);

    await expect(
      risk_correlation_service.run_root_cause_bucketing(makeReq({})),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends risks by ref (not id) and findings mapped from Action, with the internal-secret header and a signed org-identity token (#56)', async () => {
    riskDb.findMany.mockResolvedValue([
      {
        ref: 'CYB-001',
        name: 'Ransomware',
        description: 'desc',
        category: 'Cyber',
        inherent_score: 80,
        residual_score: 60,
        probability: 40,
        site_id: 'site-1',
      },
    ]);
    actionDb.findMany.mockResolvedValue([
      {
        id: 'action-1',
        actionTitle: 'Patch systems',
        actionDisc: 'Patch it',
        priority: 'High',
        status: 'TO_DO',
      },
    ]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ methodology: 'test', riskBuckets: [], findingBuckets: [] }),
    });

    await risk_correlation_service.run_root_cause_bucketing(makeReq({}));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/risk/rootcause-bucketing');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Internal-Secret']).toBeDefined();
    expect(init.headers['X-Org-Token']).toBeDefined();
    expect(jwtDecode(init.headers['X-Org-Token']).org_account_id).toBe(ORG_A);

    const body = JSON.parse(init.body);
    expect(body.organizationContext).toEqual({
      name: 'Acme',
      sector: 'Manufacturing',
      country: 'France',
    });
    expect(body.risks).toEqual([
      {
        ref: 'CYB-001',
        name: 'Ransomware',
        description: 'desc',
        category: 'Cyber',
        inherentScore: 80,
        residualScore: 60,
        probability: 40,
        siteId: 'site-1',
      },
    ]);
    expect(body.findings).toEqual([
      {
        ref: 'action-1',
        title: 'Patch systems',
        description: 'Patch it',
        priority: 'High',
        status: 'TO_DO',
      },
    ]);
  });

  it('returns the aexa-ai bucketing result on success', async () => {
    riskDb.findMany.mockResolvedValue([{ ref: 'CYB-001', name: 'Ransomware', category: 'Cyber' }]);
    actionDb.findMany.mockResolvedValue([]);
    const aiResult = {
      methodology: 'pagerank',
      riskBuckets: [{ bucketName: 'IT gaps' }],
      findingBuckets: [],
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => aiResult });

    const result = await risk_correlation_service.run_root_cause_bucketing(makeReq({}));

    expect(result).toEqual(aiResult);
  });

  it('wraps a non-ok aexa-ai response as a 502', async () => {
    riskDb.findMany.mockResolvedValue([{ ref: 'CYB-001', name: 'Ransomware', category: 'Cyber' }]);
    actionDb.findMany.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503 });

    await expect(
      risk_correlation_service.run_root_cause_bucketing(makeReq({})),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it('wraps a network failure as a generic 500, not the raw error', async () => {
    riskDb.findMany.mockResolvedValue([{ ref: 'CYB-001', name: 'Ransomware', category: 'Cyber' }]);
    actionDb.findMany.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      risk_correlation_service.run_root_cause_bucketing(makeReq({})),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: 'Failed to run root-cause bucketing analysis',
    });
  });
});

describe('risk_correlation_service — POST /risk/root-cause-bucketing/create-action (#191)', () => {
  const bucketBody = {
    description: 'Roll out centralized patch management across all sites',
    normReference: 'ISO 27001 A.12.6.1',
    owner: 'IT Security',
    priority: 'immediate' as const,
    estimatedRiskReduction: 35,
    estimatedCost: '$50,000',
    timeline: '3-6 months',
    riskRefs: ['CYB-001', 'CYB-002'],
  };

  const mockMembership = (role: 'ADMIN' | 'LEAD_AUDITOR' | 'LIGHT_USER' | 'VIEWER') => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: 'member-1',
      organizationId: 'org-real-id',
      accountId: ORG_A,
      role,
      status: 'ACTIVE',
      expiresAt: null,
    });
    (prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>).findUnique = vi
      .fn()
      .mockResolvedValue({ id: 'org-real-id', anchorAccountId: ORG_A });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null); // ADMIN-of-self fallback by default
    // findOrCreateSyntheticInspection now runs inside prisma.$transaction to
    // close a TOCTOU race (round-1 review) -- the mock just invokes the
    // callback with the same mocked `prisma` object as `tx`, so every
    // existing templateDb/inspectionDb/siteDb mock in this file keeps
    // working unchanged.
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: (tx: typeof prisma) => unknown) => cb(prisma),
    );
    (prisma.$executeRaw as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    // riskRefs is now validated against real org-scoped Risk rows (round-1
    // review) -- default to both bucketBody refs existing, so every
    // existing test in this block keeps passing without needing to know
    // about the new check; the dedicated validation tests below override
    // this per-case.
    riskDb.findMany.mockResolvedValue([{ ref: 'CYB-001' }, { ref: 'CYB-002' }]);
  });

  it('403s a VIEWER (not ADMIN/LEAD_AUDITOR)', async () => {
    mockMembership('VIEWER');

    await expect(
      risk_correlation_service.create_action_from_bucket(makeReq({ body: bucketBody })),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(templateDb.findFirst).not.toHaveBeenCalled();
    expect(actionDb.create).not.toHaveBeenCalled();
  });

  it('403s a LIGHT_USER', async () => {
    mockMembership('LIGHT_USER');

    await expect(
      risk_correlation_service.create_action_from_bucket(makeReq({ body: bucketBody })),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows a LEAD_AUDITOR (same gate as create-risk-from-item)', async () => {
    mockMembership('LEAD_AUDITOR');
    templateDb.findFirst.mockResolvedValue({ id: 'template-1' });
    inspectionDb.findFirst.mockResolvedValue({ id: 'inspection-1', siteId: 'site-1' });
    actionDb.create.mockResolvedValue({ id: 'action-1' });

    await risk_correlation_service.create_action_from_bucket(makeReq({ body: bucketBody }));

    expect(actionDb.create).toHaveBeenCalledTimes(1);
  });

  it('409s when the org has no sites and no synthetic inspection exists yet', async () => {
    templateDb.findFirst.mockResolvedValue(null);
    templateDb.create.mockResolvedValue({ id: 'template-1' });
    inspectionDb.findFirst.mockResolvedValue(null);
    siteDb.findFirst.mockResolvedValue(null);

    await expect(
      risk_correlation_service.create_action_from_bucket(makeReq({ body: bucketBody })),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(actionDb.create).not.toHaveBeenCalled();
  });

  it('creates the synthetic Template + Inspection on first use for the org', async () => {
    templateDb.findFirst.mockResolvedValue(null);
    templateDb.create.mockResolvedValue({ id: 'template-new' });
    inspectionDb.findFirst.mockResolvedValue(null);
    siteDb.findFirst.mockResolvedValue({ id: 'site-earliest' });
    inspectionDb.create.mockResolvedValue({ id: 'inspection-new', siteId: 'site-earliest' });
    actionDb.create.mockResolvedValue({ id: 'action-1' });

    await risk_correlation_service.create_action_from_bucket(makeReq({ body: bucketBody }));

    expect(templateDb.findFirst).toHaveBeenCalledWith({
      where: { orgAccountId: ORG_A, templateName: '⚙ AI-Generated Findings (system, do not edit)' },
    });
    expect(templateDb.create).toHaveBeenCalledWith({
      data: { orgAccountId: ORG_A, templateName: '⚙ AI-Generated Findings (system, do not edit)' },
    });
    expect(inspectionDb.findFirst).toHaveBeenCalledWith({
      where: { orgAccountId: ORG_A, templateId: 'template-new' },
    });
    expect(siteDb.findFirst).toHaveBeenCalledWith({
      where: { org_account_id: ORG_A },
      orderBy: { createdAt: 'asc' },
    });
    expect(inspectionDb.create).toHaveBeenCalledWith({
      data: { orgAccountId: ORG_A, templateId: 'template-new', siteId: 'site-earliest' },
    });
    expect(actionDb.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inspectionId: 'inspection-new',
        siteId: 'site-earliest',
      }),
    });
  });

  it('reuses the same synthetic Template + Inspection on a second call — idempotent, no duplicates', async () => {
    templateDb.findFirst.mockResolvedValue({ id: 'template-existing' });
    inspectionDb.findFirst.mockResolvedValue({ id: 'inspection-existing', siteId: 'site-1' });
    actionDb.create.mockResolvedValue({ id: 'action-1' });

    await risk_correlation_service.create_action_from_bucket(makeReq({ body: bucketBody }));
    await risk_correlation_service.create_action_from_bucket(makeReq({ body: bucketBody }));

    expect(templateDb.create).not.toHaveBeenCalled();
    expect(inspectionDb.create).not.toHaveBeenCalled();
    expect(actionDb.create).toHaveBeenCalledTimes(2);
    expect(actionDb.create.mock.calls[0][0].data.inspectionId).toBe('inspection-existing');
    expect(actionDb.create.mock.calls[1][0].data.inspectionId).toBe('inspection-existing');
  });

  it.each([
    ['immediate', 'High'],
    ['short_term', 'High'],
    ['medium_term', 'Medium'],
    ['long_term', 'Low'],
  ] as const)('maps AI priority %s onto Action priority %s', async (aiPriority, actionPriority) => {
    templateDb.findFirst.mockResolvedValue({ id: 'template-1' });
    inspectionDb.findFirst.mockResolvedValue({ id: 'inspection-1', siteId: 'site-1' });
    actionDb.create.mockResolvedValue({ id: 'action-1' });

    await risk_correlation_service.create_action_from_bucket(
      makeReq({ body: { ...bucketBody, priority: aiPriority } }),
    );

    expect(actionDb.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ priority: actionPriority }),
    });
  });

  it('creates the Action with the mapped fields, provenance flags, and every riskRef folded into actionDisc', async () => {
    templateDb.findFirst.mockResolvedValue({ id: 'template-1' });
    inspectionDb.findFirst.mockResolvedValue({ id: 'inspection-1', siteId: 'site-1' });
    actionDb.create.mockResolvedValue({ id: 'action-1' });

    const result = await risk_correlation_service.create_action_from_bucket(
      makeReq({ body: bucketBody }),
    );

    expect(actionDb.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgAccountId: ORG_A,
        inspectionId: 'inspection-1',
        siteId: 'site-1',
        actionTitle: bucketBody.description,
        priority: 'High',
        status: 'TO_DO',
        line_of_defense: 'FIRST',
        ai_generated: true,
        is_edited: false,
      }),
    });
    const actionDisc = actionDb.create.mock.calls[0][0].data.actionDisc as string;
    expect(actionDisc).toContain(bucketBody.normReference);
    expect(actionDisc).toContain(bucketBody.owner);
    expect(actionDisc).toContain(bucketBody.timeline);
    expect(actionDisc).toContain(bucketBody.estimatedCost);
    expect(actionDisc).toContain('CYB-001');
    expect(actionDisc).toContain('CYB-002');
    expect(result).toEqual({ id: 'action-1' });
  });

  it('truncates an overlong description into actionTitle but keeps it in full in actionDisc', async () => {
    templateDb.findFirst.mockResolvedValue({ id: 'template-1' });
    inspectionDb.findFirst.mockResolvedValue({ id: 'inspection-1', siteId: 'site-1' });
    actionDb.create.mockResolvedValue({ id: 'action-1' });
    const longDescription = 'x'.repeat(300);

    await risk_correlation_service.create_action_from_bucket(
      makeReq({ body: { ...bucketBody, description: longDescription } }),
    );

    const data = actionDb.create.mock.calls[0][0].data;
    expect((data.actionTitle as string).length).toBeLessThanOrEqual(255);
    expect(data.actionDisc as string).toContain(longDescription);
  });

  // Round-1 review: riskRefs was folded into actionDisc with no check that
  // the refs actually resolve to real, org-scoped Risk rows -- a client
  // could embed another org's ref, or a fabricated string, unchecked.
  describe('riskRefs validation', () => {
    it('404s when a riskRef does not resolve to any Risk in the caller org', async () => {
      riskDb.findMany.mockResolvedValue([{ ref: 'CYB-001' }]); // CYB-002 missing

      await expect(
        risk_correlation_service.create_action_from_bucket(makeReq({ body: bucketBody })),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(templateDb.findFirst).not.toHaveBeenCalled();
      expect(actionDb.create).not.toHaveBeenCalled();
    });

    it('scopes the riskRefs existence check to the caller org', async () => {
      riskDb.findMany.mockResolvedValue([{ ref: 'CYB-001' }, { ref: 'CYB-002' }]);
      templateDb.findFirst.mockResolvedValue({ id: 'template-1' });
      inspectionDb.findFirst.mockResolvedValue({ id: 'inspection-1', siteId: 'site-1' });
      actionDb.create.mockResolvedValue({ id: 'action-1' });

      await risk_correlation_service.create_action_from_bucket(makeReq({ body: bucketBody }));

      expect(riskDb.findMany).toHaveBeenCalledWith({
        where: { org_account_id: ORG_A, ref: { in: bucketBody.riskRefs } },
        select: { ref: true },
      });
    });
  });
});
