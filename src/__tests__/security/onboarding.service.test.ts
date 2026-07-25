import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    account: { create: vi.fn(), findFirst: vi.fn() },
    organizationProfile: { create: vi.fn(), findFirst: vi.fn() },
    organization: { create: vi.fn() },
    orgMember: { create: vi.fn() },
    site: { create: vi.fn() },
    // aexa-frontend#142: commit_onboarding now calls computeNextRiskRef (via
    // the tx client) before each risk create, which reads existing refs via
    // risk.findMany.
    risk: { create: vi.fn(), findMany: vi.fn() },
    kri: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { _internal, onboarding_service } from '../../app/modules/onboarding/onboarding.service.js';

const db = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
const mockTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;

const ADMIN = { accountId: 'admin-1', role: 'ADMIN', email: 'admin@qiyrix.test' };

// A tx client whose create fns are the same mocks as the top-level ones, so
// assertions can inspect them directly.
const makeTx = () => ({
  account: db.account,
  organizationProfile: db.organizationProfile,
  organization: db.organization,
  orgMember: db.orgMember,
  site: db.site,
  risk: db.risk,
  kri: db.kri,
});

function aiRisk(overrides: Record<string, unknown> = {}) {
  return {
    risk_id: 'r1',
    title: 'Supplier concentration',
    description: 'Single supplier for a critical part',
    category: 'Supply Chain',
    site: 'Lyon Plant',
    inherent_risk_score: 'High',
    residual_risk_score: 'Medium',
    Probability: 0.6,
    minimum_Impact: 'x',
    maximum_impact: 'y',
    Velocity: 'high',
    Trend: 'stable',
    Responsable: 'Supply Chain Manager',
    score: 14,
    ...overrides,
  };
}

describe('onboarding service — identify (Stage 1 proxy)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns the aexa-ai company profile on success and does not persist anything', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ sector: 'Manufacturing', sites: 2 }),
    });

    const result = await onboarding_service.identify_company(
      makeReq({ user: ADMIN, body: { company_name: 'Acme' } }),
    );

    expect(result).toEqual({ sector: 'Manufacturing', sites: 2 });
    expect(db.account.create).not.toHaveBeenCalled();
    expect(db.site.create).not.toHaveBeenCalled();
  });

  it('throws 502 when the AI service errors', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503 });
    await expect(
      onboarding_service.identify_company(makeReq({ user: ADMIN, body: { company_name: 'Acme' } })),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('onboarding service — generate (Stage 3, not persisted)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('maps AI risks into Risk-model draft shape and attaches template KRIs, persisting nothing', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.endsWith('/risk_analysis')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ risks: [aiRisk()] }) });
      }
      if (url.endsWith('/kri-baseline')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              kri_baselines: [
                {
                  category: 'Supply Chain',
                  name: 'Supplier On-Time Delivery %',
                  unit: '%',
                  direction: 'lower_is_worse',
                  alert_threshold: 90,
                  target_value: 98,
                  frequency: 'Monthly',
                  is_suggested_threshold: true,
                },
              ],
            }),
        });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const result = await onboarding_service.generate_baseline(
      makeReq({ user: ADMIN, body: { sites: [{ site_name: 'Lyon Plant' }] } }),
    );

    const site = (result as any).sites[0];
    const risk = site.risks[0];
    expect(risk.name).toBe('Supplier concentration'); // title -> name
    expect(risk.category).toBe('Supply Chain');
    expect(risk.inherent_score).toBe(14); // score -> inherent_score
    expect(risk.probability).toBe(60); // 0.6 -> 60
    expect(risk.status).toBe('open');
    // KRI template attached under the matching-category risk.
    expect(risk.kris).toHaveLength(1);
    expect(risk.kris[0]).toMatchObject({ name: 'Supplier On-Time Delivery %', current_value: 0 });

    // Draft only — nothing written.
    expect(db.site.create).not.toHaveBeenCalled();
    expect(db.risk.create).not.toHaveBeenCalled();
    expect(db.kri.create).not.toHaveBeenCalled();
  });

  it('throws 502 when a per-site /risk_analysis call fails', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500 });
    await expect(
      onboarding_service.generate_baseline(
        makeReq({ user: ADMIN, body: { sites: [{ site_name: 'Lyon Plant' }] } }),
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('onboarding service — commit (Stage 4, transactional)', () => {
  const commitBody = () => ({
    organizationName: 'Acme Corp',
    email: 'admin@acme.test',
    password: 'supersecret',
    sector: 'Manufacturing',
    country: 'France',
    sites: [
      {
        name: 'Lyon Plant',
        location: 'Lyon',
        country: 'France',
        activity: 'Manufacturing',
        revenue: 5000000,
        employees_count: 250,
        site_type: 'Production',
        source_info: 'https://example.com/lyon',
        risks: [
          {
            name: 'Supplier concentration',
            description: 'Single supplier',
            category: 'Supply Chain',
            inherent_score: 14,
            residual_score: null,
            probability: 60,
            velocity: 'high',
            trend: 'stable',
            status: 'open',
            source_info: null,
            financial_impact_min: null,
            financial_impact_max: null,
            kris: [
              {
                name: 'Supplier On-Time Delivery %',
                unit: '%',
                current_value: 0,
                alert_threshold: 90,
                target_value: 98,
                frequency: 'Monthly',
              },
            ],
          },
        ],
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    db.account.findFirst.mockResolvedValue(null);
    db.organizationProfile.findFirst.mockResolvedValue(null);
    db.account.create.mockResolvedValue({ id: 'acc-1', email: 'admin@acme.test' });
    db.organizationProfile.create.mockResolvedValue({ id: 'prof-1' });
    db.organization.create.mockResolvedValue({ id: 'org-1', name: 'Acme Corp' });
    db.orgMember.create.mockResolvedValue({ id: 'mem-1' });
    db.site.create.mockResolvedValue({ id: 'site-1' });
    db.risk.create.mockResolvedValue({ id: 'risk-1' });
    // aexa-frontend#142: computeNextRiskRef reads existing refs before each
    // risk create; no pre-existing refs in these fixtures.
    db.risk.findMany.mockResolvedValue([]);
    db.kri.create.mockResolvedValue({ id: 'kri-1' });
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(makeTx()),
    );
  });

  it('creates the org tenant + all sites/risks/kris in ONE transaction, every AI row flagged', async () => {
    const result = await onboarding_service.commit_onboarding(
      makeReq({ user: ADMIN, body: commitBody() }),
    );

    // Exactly one transaction wraps the whole commit.
    expect(mockTransaction).toHaveBeenCalledTimes(1);

    // Tenant scaffolding created via the shared helper.
    expect(db.account.create).toHaveBeenCalledTimes(1);
    expect(db.orgMember.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'ADMIN' }) }),
    );

    // Site scoped to the new org account and flagged AI-generated with source.
    expect(db.site.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          org_account_id: 'acc-1',
          name: 'Lyon Plant',
          ai_generated: true,
          source_info: 'https://example.com/lyon',
        }),
      }),
    );
    // Risk hangs off the created site, flagged AI-generated.
    expect(db.risk.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          org_account_id: 'acc-1',
          site_id: 'site-1',
          category: 'Supply Chain',
          ai_generated: true,
        }),
      }),
    );
    // KRI hangs off the created risk, flagged AI-generated.
    expect(db.kri.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          org_account_id: 'acc-1',
          risk_id: 'risk-1',
          ai_generated: true,
        }),
      }),
    );

    expect(result).toMatchObject({
      account: { id: 'acc-1' },
      organization: { id: 'org-1' },
      counts: { sites: 1, risks: 1, kris: 1 },
    });
  });

  it('all-or-nothing: a failure partway through rejects (so Postgres rolls back) and never returns a partial org', async () => {
    // Risk insert fails after the site + tenant inserts already ran.
    db.risk.create.mockRejectedValue(new Error('DB write failed'));

    await expect(
      onboarding_service.commit_onboarding(makeReq({ user: ADMIN, body: commitBody() })),
    ).rejects.toMatchObject({ statusCode: 500 });

    // The whole thing ran inside the single transaction (whose rejection is
    // what triggers the Postgres rollback), and nothing past the failure point
    // was attempted — no KRI written under a risk that never committed.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(db.kri.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate email with 400 BEFORE opening the transaction (nothing persists)', async () => {
    db.account.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(
      onboarding_service.commit_onboarding(makeReq({ user: ADMIN, body: commitBody() })),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(db.account.create).not.toHaveBeenCalled();
    expect(db.site.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate organization name with 400 BEFORE opening the transaction (#212 — nothing persists)', async () => {
    // Email is free, but an OrganizationProfile already uses this name.
    db.account.findFirst.mockResolvedValue(null);
    db.organizationProfile.findFirst.mockResolvedValue({ id: 'existing-profile' });

    await expect(
      onboarding_service.commit_onboarding(makeReq({ user: ADMIN, body: commitBody() })),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/organization with this name already exists/i),
    });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(db.account.create).not.toHaveBeenCalled();
    expect(db.site.create).not.toHaveBeenCalled();
  });

  it('concurrent same-email commit that loses the race inside the tx surfaces a clean 400, not a 500 (#209)', async () => {
    // The pre-check passes (no existing account at read time)...
    db.account.findFirst.mockResolvedValue(null);
    // ...but a concurrent commit wins first, so this one hits the
    // Account.email unique constraint (P2002) INSIDE the transaction.
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    mockTransaction.mockRejectedValue(p2002);

    await expect(
      onboarding_service.commit_onboarding(makeReq({ user: ADMIN, body: commitBody() })),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'An account with this email already exists',
    });

    // The pre-check ran and the transaction was attempted (the race is only
    // detectable inside it); it's the surfaced error that must be a clean 400.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('passes an explicit (non-default) transaction timeout so large payloads have headroom (#210)', async () => {
    await onboarding_service.commit_onboarding(makeReq({ user: ADMIN, body: commitBody() }));

    const [, options] = mockTransaction.mock.calls[0];
    expect(options).toMatchObject({ timeout: expect.any(Number) });
    expect(options.timeout).toBeGreaterThan(5000);
  });
});

describe('onboarding service — normalizeProbability (#211)', () => {
  const { normalizeProbability } = _internal;

  it('scales a 0-1 fraction to an integer percentage', () => {
    expect(normalizeProbability(0.6)).toBe(60);
    expect(normalizeProbability(0)).toBe(0);
    expect(normalizeProbability(1)).toBe(100);
    expect(normalizeProbability(0.125)).toBe(13); // rounded
  });

  it('treats a plausible 1-100 value as an already-percentage instead of multiplying it into garbage', () => {
    // The exact bug: a model emitting 60 (meaning 60%) must NOT become 6000.
    expect(normalizeProbability(60)).toBe(60);
    expect(normalizeProbability(100)).toBe(100);
  });

  it('drops a malformed out-of-range value rather than silently storing it', () => {
    expect(normalizeProbability(6000)).toBeNull();
    expect(normalizeProbability(-1)).toBeNull();
    expect(normalizeProbability(Number.NaN)).toBeNull();
    expect(normalizeProbability(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeProbability('60')).toBeNull();
    expect(normalizeProbability(undefined)).toBeNull();
  });
});
