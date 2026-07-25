import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

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
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { risk_correlation_service } from '../../app/modules/risk/risk.correlation.service.js';

const riskDb = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskLinkDb = prisma.riskLink as unknown as Record<string, ReturnType<typeof vi.fn>>;
const actionDb = prisma.action as unknown as Record<string, ReturnType<typeof vi.fn>>;
const accountDb = prisma.account as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;

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
      where: { org_account_id: ORG_A },
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

  it('sends risks by ref (not id) and findings mapped from Action, with the internal-secret header', async () => {
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
