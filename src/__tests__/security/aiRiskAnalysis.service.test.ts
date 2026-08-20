import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    site: { findFirst: vi.fn() },
    risk: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    regulatoryFramework: { findMany: vi.fn() },
    aiRiskAnalysisRun: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    orgMember: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { ai_risk_analysis_service } from '../../app/modules/aiRiskAnalysis/aiRiskAnalysis.service.js';

const siteDb = prisma.site as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskDb = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
const frameworkDb = prisma.regulatoryFramework as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const runDb = prisma.aiRiskAnalysisRun as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;

const SITE = {
  id: 'site-1',
  org_account_id: ORG_A,
  name: 'Fives Nordon - Nancy',
  location: 'Nancy, France',
  country: 'France',
  activity: 'Industrial piping and pressure vessel fabrication',
  description: null,
  revenue: 50_000_000,
  employees_count: 300,
  site_type: 'Manufacturing plant',
};

function mockAiResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function flush(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ai_risk_analysis_service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    orgMemberDb.findUnique.mockResolvedValue(null);
    riskDb.findMany.mockResolvedValue([]);
    riskDb.create.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'risk-new', ref: 'GEN-001', ...args.data }),
    );
    frameworkDb.findMany.mockResolvedValue([]);
    runDb.update.mockResolvedValue({});
    // Default: the guarded updateMany "wins" the race (count: 1) --
    // individual tests override to simulate a lost race (count: 0).
    runDb.updateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('start_ai_risk_analysis', () => {
    it('throws 404 when the site does not exist or belongs to another org', async () => {
      siteDb.findFirst.mockResolvedValue(null);

      await expect(
        ai_risk_analysis_service.start_ai_risk_analysis(makeReq({ body: { siteId: 'site-1' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(siteDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'site-1', org_account_id: ORG_A },
      });
    });

    it('throws 400 when the site has no activity set', async () => {
      siteDb.findFirst.mockResolvedValue({ ...SITE, activity: '  ' });

      await expect(
        ai_risk_analysis_service.start_ai_risk_analysis(makeReq({ body: { siteId: 'site-1' } })),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('throws 429 when the site was analyzed within the last 10 minutes', async () => {
      siteDb.findFirst.mockResolvedValue(SITE);
      runDb.findFirst.mockResolvedValue({
        id: 'run-prev',
        started_at: new Date(Date.now() - 60_000),
      });

      await expect(
        ai_risk_analysis_service.start_ai_risk_analysis(makeReq({ body: { siteId: 'site-1' } })),
      ).rejects.toMatchObject({ statusCode: 429 });

      expect(runDb.create).not.toHaveBeenCalled();
    });

    it('allows a new run once the 10-minute cooldown has elapsed', async () => {
      siteDb.findFirst.mockResolvedValue(SITE);
      runDb.findFirst.mockResolvedValue({
        id: 'run-prev',
        started_at: new Date(Date.now() - 11 * 60_000),
      });
      runDb.create.mockResolvedValue({ id: 'run-new', status: 'running' });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockAiResponse({ categories: [] }));

      const result = await ai_risk_analysis_service.start_ai_risk_analysis(
        makeReq({ body: { siteId: 'site-1' } }),
      );

      expect(result).toMatchObject({ id: 'run-new', status: 'running' });
    });

    it('creates the run row org-scoped and returns immediately without waiting for generation', async () => {
      siteDb.findFirst.mockResolvedValue(SITE);
      runDb.findFirst.mockResolvedValue(null);
      runDb.create.mockResolvedValue({ id: 'run-new', status: 'running' });
      // fetch never resolves -- proves start_ai_risk_analysis doesn't await it.
      (fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

      const result = await ai_risk_analysis_service.start_ai_risk_analysis(
        makeReq({ body: { siteId: 'site-1' } }),
      );

      expect(result).toMatchObject({ id: 'run-new' });
      expect(runDb.create).toHaveBeenCalledWith({
        data: {
          site_id: 'site-1',
          org_account_id: ORG_A,
          triggered_by_account_id: ORG_A,
          status: 'running',
        },
      });
    });
  });

  describe('get_ai_risk_analysis_run', () => {
    it('throws 404 for a run belonging to another org or that does not exist', async () => {
      runDb.findFirst.mockResolvedValue(null);

      await expect(
        ai_risk_analysis_service.get_ai_risk_analysis_run(makeReq({ params: { id: 'run-1' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(runDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'run-1', org_account_id: ORG_A },
      });
    });

    it('returns the run with a risks_created count', async () => {
      runDb.findFirst.mockResolvedValue({ id: 'run-1', status: 'completed' });
      riskDb.count.mockResolvedValue(12);

      const result = await ai_risk_analysis_service.get_ai_risk_analysis_run(
        makeReq({ params: { id: 'run-1' } }),
      );

      expect(result).toMatchObject({ id: 'run-1', status: 'completed', risks_created: 12 });
      expect(riskDb.count).toHaveBeenCalledWith({ where: { ai_generation_run_id: 'run-1' } });
    });
  });

  describe('runAnalysis (exercised via start_ai_risk_analysis)', () => {
    it('applies the deterministic threshold check and persists a downgraded risk when the site does not clear a threshold-gated framework', async () => {
      siteDb.findFirst.mockResolvedValue(SITE); // employees_count 300 < 500 required by Sapin II
      runDb.findFirst.mockResolvedValue(null);
      runDb.create.mockResolvedValue({ id: 'run-new', status: 'running' });
      frameworkDb.findMany.mockResolvedValue([
        {
          id: 'framework-sapin-ii',
          name: 'Loi Sapin II',
          official_reference: 'Loi n° 2016-1691',
          jurisdiction: 'France',
          domain: 'compliance',
          legal_status: 'conditional_statutory',
          applicability_threshold: { min_employees: 500, min_revenue_eur: 100_000_000 },
          summary: 'Anti-corruption compliance obligations for large groups.',
        },
      ]);

      (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
        if (url.endsWith('/risk_triage')) {
          return Promise.resolve(
            mockAiResponse({
              categories: [
                {
                  category: 'compliance',
                  applies: true,
                  reasoning: 'Group-wide compliance exposure',
                  estimated_risk_count: 1,
                },
              ],
            }),
          );
        }
        if (url.endsWith('/risk_category_generation')) {
          return Promise.resolve(
            mockAiResponse({
              risks: [
                {
                  name: 'Failure to implement anti-corruption program',
                  description: 'Sapin II anti-corruption compliance gap',
                  applicability_reasoning: 'Site is part of a large group',
                  legal_status: 'conditional_statutory',
                  regulatory_official_reference: 'Loi n° 2016-1691',
                  regulatory_citation_note: null,
                  citation_confidence: 'curated_verified',
                  probability: 40,
                  impact: 60,
                  financial_impact_min: 50,
                  financial_impact_max: 500,
                  velocity: 'medium',
                  trend: 'none',
                  control_design_eff: 30,
                  control_operating_eff: 30,
                  internal_pilot: 'Compliance Officer',
                },
              ],
            }),
          );
        }
        return Promise.resolve(mockAiResponse({}, false, 404));
      });

      await ai_risk_analysis_service.start_ai_risk_analysis(
        makeReq({ body: { siteId: 'site-1' } }),
      );
      await flush();

      expect(riskDb.create).toHaveBeenCalledTimes(1);
      const created = riskDb.create.mock.calls[0][0].data;
      // Site's employees_count (300) is below Sapin II's 500 threshold --
      // the model claimed curated_verified/conditional_statutory, but the
      // deterministic check must downgrade citation_confidence to
      // ai_estimate regardless (design-docs §10).
      expect(created.citation_confidence).toBe('ai_estimate');
      expect(created.legal_status).toBe('conditional_statutory');
      expect(created.regulatory_framework_id).toBe('framework-sapin-ii');
      expect(created.ai_generation_run_id).toBe('run-new');
      expect(created.ai_generated).toBe(true);
      // docs/design-docs/ai-risk-review-approval-workflow.md -- AI-generated
      // risks start unreviewed, not the schema's APPROVED default.
      expect(created.review_status).toBe('PENDING_REVIEW');
      // Dedup context (fetchExistingRiskTitles) counts APPROVED +
      // PENDING_REVIEW, excluding DISMISSED -- a reviewer's rejection isn't
      // a permanent "never applicable" verdict.
      expect(riskDb.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            review_status: { in: ['APPROVED', 'PENDING_REVIEW'] },
          }),
        }),
      );
      expect(created.status).toBe('open');

      expect(runDb.update).toHaveBeenLastCalledWith({
        where: { id: 'run-new' },
        data: expect.objectContaining({ status: 'completed' }),
      });
    });

    it('downgrades a curated_verified claim that has no regulatory_official_reference at all', async () => {
      // Review finding: the original threshold-check block only downgraded
      // a false curated_verified claim when a reference WAS given but
      // failed to resolve -- a claim with none/an empty reference slipped
      // through untouched.
      siteDb.findFirst.mockResolvedValue(SITE);
      runDb.findFirst.mockResolvedValue(null);
      runDb.create.mockResolvedValue({ id: 'run-new', status: 'running' });
      frameworkDb.findMany.mockResolvedValue([]);

      (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
        if (url.endsWith('/risk_triage')) {
          return Promise.resolve(
            mockAiResponse({
              categories: [
                { category: 'cyber', applies: true, reasoning: 'r', estimated_risk_count: 1 },
              ],
            }),
          );
        }
        if (url.endsWith('/risk_category_generation')) {
          return Promise.resolve(
            mockAiResponse({
              risks: [
                {
                  name: 'Unsubstantiated claim',
                  description: 'desc',
                  applicability_reasoning: 'reason',
                  legal_status: 'active_statutory',
                  regulatory_official_reference: null,
                  regulatory_citation_note: null,
                  citation_confidence: 'curated_verified',
                  probability: 50,
                  impact: 50,
                  financial_impact_min: 10,
                  financial_impact_max: 100,
                  velocity: 'medium',
                  trend: 'none',
                  control_design_eff: 50,
                  control_operating_eff: 50,
                  internal_pilot: null,
                },
              ],
            }),
          );
        }
        return Promise.resolve(mockAiResponse({}, false, 404));
      });

      await ai_risk_analysis_service.start_ai_risk_analysis(
        makeReq({ body: { siteId: 'site-1' } }),
      );
      await flush();

      const created = riskDb.create.mock.calls[0][0].data;
      expect(created.citation_confidence).toBe('ai_estimate');
      expect(created.regulatory_framework_id).toBeNull();
    });

    it('applies the deterministic threshold check for a Devoir-de-Vigilance-shaped threshold (min_employees_france/worldwide, no revenue field)', async () => {
      siteDb.findFirst.mockResolvedValue({ ...SITE, employees_count: 300 }); // below both 5000/10000
      runDb.findFirst.mockResolvedValue(null);
      runDb.create.mockResolvedValue({ id: 'run-new', status: 'running' });
      frameworkDb.findMany.mockResolvedValue([
        {
          id: 'framework-devoir',
          name: 'Devoir de Vigilance',
          official_reference: 'Loi n°2017-399',
          jurisdiction: 'France',
          domain: 'anti_corruption',
          legal_status: 'conditional_statutory',
          applicability_threshold: { min_employees_france: 5000, min_employees_worldwide: 10000 },
          summary: 'Vigilance plan obligations for very large groups.',
        },
      ]);

      (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
        if (url.endsWith('/risk_triage')) {
          return Promise.resolve(
            mockAiResponse({
              categories: [
                { category: 'compliance', applies: true, reasoning: 'r', estimated_risk_count: 1 },
              ],
            }),
          );
        }
        if (url.endsWith('/risk_category_generation')) {
          return Promise.resolve(
            mockAiResponse({
              risks: [
                {
                  name: 'Supply chain human rights due diligence gap',
                  description: 'desc',
                  applicability_reasoning: 'reason',
                  legal_status: 'conditional_statutory',
                  regulatory_official_reference: 'Loi n°2017-399',
                  regulatory_citation_note: null,
                  citation_confidence: 'curated_verified',
                  probability: 30,
                  impact: 50,
                  financial_impact_min: 100,
                  financial_impact_max: 1000,
                  velocity: 'low',
                  trend: 'none',
                  control_design_eff: 40,
                  control_operating_eff: 40,
                  internal_pilot: null,
                },
              ],
            }),
          );
        }
        return Promise.resolve(mockAiResponse({}, false, 404));
      });

      await ai_risk_analysis_service.start_ai_risk_analysis(
        makeReq({ body: { siteId: 'site-1' } }),
      );
      await flush();

      const created = riskDb.create.mock.calls[0][0].data;
      // Before the fix, a threshold with no min_employees/min_revenue_eur
      // keys evaluated as vacuously met (both `== null` checks pass), so
      // this claim would have survived as curated_verified/
      // conditional_statutory unchanged. It must actually downgrade.
      expect(created.citation_confidence).toBe('ai_estimate');
      expect(created.legal_status).toBe('conditional_statutory');
    });

    it('nulls out an off-enum velocity/trend value instead of persisting it unfiltered', async () => {
      siteDb.findFirst.mockResolvedValue(SITE);
      runDb.findFirst.mockResolvedValue(null);
      runDb.create.mockResolvedValue({ id: 'run-new', status: 'running' });

      (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
        if (url.endsWith('/risk_triage')) {
          return Promise.resolve(
            mockAiResponse({
              categories: [
                { category: 'cyber', applies: true, reasoning: 'r', estimated_risk_count: 1 },
              ],
            }),
          );
        }
        if (url.endsWith('/risk_category_generation')) {
          return Promise.resolve(
            mockAiResponse({
              risks: [
                {
                  name: 'Off-enum risk',
                  description: 'desc',
                  applicability_reasoning: 'reason',
                  legal_status: 'voluntary_best_practice',
                  regulatory_official_reference: null,
                  regulatory_citation_note: null,
                  citation_confidence: 'none',
                  probability: 50,
                  impact: 50,
                  financial_impact_min: 10,
                  financial_impact_max: 100,
                  velocity: 'very high',
                  trend: 'stable',
                  control_design_eff: 50,
                  control_operating_eff: 50,
                  internal_pilot: null,
                },
              ],
            }),
          );
        }
        return Promise.resolve(mockAiResponse({}, false, 404));
      });

      await ai_risk_analysis_service.start_ai_risk_analysis(
        makeReq({ body: { siteId: 'site-1' } }),
      );
      await flush();

      const created = riskDb.create.mock.calls[0][0].data;
      expect(created.velocity).toBeNull();
      expect(created.trend).toBeNull();
    });

    it('does NOT downgrade a citation to a framework whose applicability_threshold is a qualitative note, not a numeric gate', async () => {
      // Round-2 review finding: an earlier version of the threshold check
      // treated ANY non-null applicability_threshold as evaluable, so a
      // note-only object (the real seeded shape for ATEX/ICPE/CBAM/the AI
      // Act/etc -- see seed-regulatory-frameworks.ts) fell into the
      // "unrecognized shape -> fails" branch and got silently downgraded
      // even when the citation was well-grounded. design-docs §10 scopes
      // the deterministic check to Sapin II/Devoir de Vigilance/CSRD only.
      siteDb.findFirst.mockResolvedValue(SITE);
      runDb.findFirst.mockResolvedValue(null);
      runDb.create.mockResolvedValue({ id: 'run-new', status: 'running' });
      frameworkDb.findMany.mockResolvedValue([
        {
          id: 'framework-atex',
          name: 'ATEX',
          official_reference: '2014/34/UE + 1999/92/CE',
          jurisdiction: 'European Union',
          domain: 'health_safety',
          legal_status: 'active_statutory',
          applicability_threshold: { note: 'Only applies to sites with explosive atmospheres.' },
          summary: 'Explosive atmosphere safety requirements.',
        },
      ]);

      (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
        if (url.endsWith('/risk_triage')) {
          return Promise.resolve(
            mockAiResponse({
              categories: [
                { category: 'ehs', applies: true, reasoning: 'r', estimated_risk_count: 1 },
              ],
            }),
          );
        }
        if (url.endsWith('/risk_category_generation')) {
          return Promise.resolve(
            mockAiResponse({
              risks: [
                {
                  name: 'Explosive atmosphere in solvent storage area',
                  description: 'desc',
                  applicability_reasoning: 'Site stores flammable solvents',
                  legal_status: 'active_statutory',
                  regulatory_official_reference: '2014/34/UE + 1999/92/CE',
                  regulatory_citation_note: null,
                  citation_confidence: 'curated_verified',
                  probability: 30,
                  impact: 60,
                  financial_impact_min: 50,
                  financial_impact_max: 400,
                  velocity: 'high',
                  trend: 'none',
                  control_design_eff: 60,
                  control_operating_eff: 60,
                  internal_pilot: null,
                },
              ],
            }),
          );
        }
        return Promise.resolve(mockAiResponse({}, false, 404));
      });

      await ai_risk_analysis_service.start_ai_risk_analysis(
        makeReq({ body: { siteId: 'site-1' } }),
      );
      await flush();

      const created = riskDb.create.mock.calls[0][0].data;
      expect(created.citation_confidence).toBe('curated_verified');
      expect(created.legal_status).toBe('active_statutory');
      expect(created.regulatory_framework_id).toBe('framework-atex');
    });

    it('leaves a curated_verified citation untouched when the site DOES clear a numeric threshold (Sapin II)', async () => {
      siteDb.findFirst.mockResolvedValue({ ...SITE, employees_count: 600, revenue: 150_000_000 });
      runDb.findFirst.mockResolvedValue(null);
      runDb.create.mockResolvedValue({ id: 'run-new', status: 'running' });
      frameworkDb.findMany.mockResolvedValue([
        {
          id: 'framework-sapin-ii',
          name: 'Loi Sapin II',
          official_reference: 'Loi n° 2016-1691',
          jurisdiction: 'France',
          domain: 'compliance',
          legal_status: 'conditional_statutory',
          applicability_threshold: { min_employees: 500, min_revenue_eur: 100_000_000 },
          summary: 'Anti-corruption compliance obligations for large groups.',
        },
      ]);

      (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
        if (url.endsWith('/risk_triage')) {
          return Promise.resolve(
            mockAiResponse({
              categories: [
                { category: 'compliance', applies: true, reasoning: 'r', estimated_risk_count: 1 },
              ],
            }),
          );
        }
        if (url.endsWith('/risk_category_generation')) {
          return Promise.resolve(
            mockAiResponse({
              risks: [
                {
                  name: 'Failure to implement anti-corruption program',
                  description: 'desc',
                  applicability_reasoning: 'Group exceeds Sapin II thresholds',
                  legal_status: 'conditional_statutory',
                  regulatory_official_reference: 'Loi n° 2016-1691',
                  regulatory_citation_note: null,
                  citation_confidence: 'curated_verified',
                  probability: 40,
                  impact: 60,
                  financial_impact_min: 50,
                  financial_impact_max: 500,
                  velocity: 'medium',
                  trend: 'none',
                  control_design_eff: 30,
                  control_operating_eff: 30,
                  internal_pilot: null,
                },
              ],
            }),
          );
        }
        return Promise.resolve(mockAiResponse({}, false, 404));
      });

      await ai_risk_analysis_service.start_ai_risk_analysis(
        makeReq({ body: { siteId: 'site-1' } }),
      );
      await flush();

      const created = riskDb.create.mock.calls[0][0].data;
      expect(created.citation_confidence).toBe('curated_verified');
      expect(created.legal_status).toBe('conditional_statutory');
    });

    it('downgrades a CSRD citation when only one of employees/revenue clears its threshold (cannot confirm 2-of-3 without balance sheet data)', async () => {
      siteDb.findFirst.mockResolvedValue({ ...SITE, employees_count: 200, revenue: 80_000_000 }); // revenue clears (>=50M), employees doesn't (<250)
      runDb.findFirst.mockResolvedValue(null);
      runDb.create.mockResolvedValue({ id: 'run-new', status: 'running' });
      frameworkDb.findMany.mockResolvedValue([
        {
          id: 'framework-csrd',
          name: 'CSRD',
          official_reference: 'Directive (UE) 2022/2464',
          jurisdiction: 'European Union',
          domain: 'environmental',
          legal_status: 'conditional_statutory',
          applicability_threshold: {
            min_employees: 250,
            min_revenue_eur: 50_000_000,
            min_balance_sheet_eur: 25_000_000,
          },
          summary: 'Sustainability reporting per ESRS standards.',
        },
      ]);

      (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
        if (url.endsWith('/risk_triage')) {
          return Promise.resolve(
            mockAiResponse({
              categories: [
                { category: 'compliance', applies: true, reasoning: 'r', estimated_risk_count: 1 },
              ],
            }),
          );
        }
        if (url.endsWith('/risk_category_generation')) {
          return Promise.resolve(
            mockAiResponse({
              risks: [
                {
                  name: 'CSRD sustainability reporting gap',
                  description: 'desc',
                  applicability_reasoning: 'reason',
                  legal_status: 'conditional_statutory',
                  regulatory_official_reference: 'Directive (UE) 2022/2464',
                  regulatory_citation_note: null,
                  citation_confidence: 'curated_verified',
                  probability: 30,
                  impact: 40,
                  financial_impact_min: 20,
                  financial_impact_max: 200,
                  velocity: 'low',
                  trend: 'none',
                  control_design_eff: 40,
                  control_operating_eff: 40,
                  internal_pilot: null,
                },
              ],
            }),
          );
        }
        return Promise.resolve(mockAiResponse({}, false, 404));
      });

      await ai_risk_analysis_service.start_ai_risk_analysis(
        makeReq({ body: { siteId: 'site-1' } }),
      );
      await flush();

      const created = riskDb.create.mock.calls[0][0].data;
      expect(created.citation_confidence).toBe('ai_estimate');
      expect(created.legal_status).toBe('conditional_statutory');
    });

    it('marks the run partial when one category succeeds and another fails, never dropping the failed category silently', async () => {
      siteDb.findFirst.mockResolvedValue(SITE);
      runDb.findFirst.mockResolvedValue(null);
      runDb.create.mockResolvedValue({ id: 'run-new', status: 'running' });

      (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string, init?: RequestInit) => {
        if (url.endsWith('/risk_triage')) {
          return Promise.resolve(
            mockAiResponse({
              categories: [
                { category: 'cyber', applies: true, reasoning: 'r1', estimated_risk_count: 1 },
                { category: 'fire', applies: true, reasoning: 'r2', estimated_risk_count: 1 },
              ],
            }),
          );
        }
        if (url.endsWith('/risk_category_generation')) {
          const body = JSON.parse((init?.body as string) ?? '{}');
          if (body.category === 'fire') {
            return Promise.resolve(mockAiResponse({}, false, 500));
          }
          return Promise.resolve(
            mockAiResponse({
              risks: [
                {
                  name: 'Cyber intrusion',
                  description: 'desc',
                  applicability_reasoning: 'reason',
                  legal_status: 'voluntary_best_practice',
                  regulatory_official_reference: null,
                  regulatory_citation_note: null,
                  citation_confidence: 'none',
                  probability: 40,
                  impact: 40,
                  financial_impact_min: 10,
                  financial_impact_max: 100,
                  velocity: 'medium',
                  trend: 'none',
                  control_design_eff: 50,
                  control_operating_eff: 50,
                  internal_pilot: null,
                },
              ],
            }),
          );
        }
        return Promise.resolve(mockAiResponse({}, false, 404));
      });

      await ai_risk_analysis_service.start_ai_risk_analysis(
        makeReq({ body: { siteId: 'site-1' } }),
      );
      await flush(500);

      const finalUpdateCall = runDb.update.mock.calls[runDb.update.mock.calls.length - 1][0];
      expect(finalUpdateCall.data.status).toBe('partial');
      expect(finalUpdateCall.data.categories_failed).toEqual(
        expect.arrayContaining([expect.objectContaining({ category: 'fire' })]),
      );
      expect(riskDb.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry_ai_risk_analysis', () => {
    function makeFailedRun(overrides: Record<string, unknown> = {}) {
      return {
        id: 'run-1',
        site_id: 'site-1',
        org_account_id: ORG_A,
        triggered_by_account_id: ORG_A,
        status: 'partial',
        triage_result: {
          categories: [
            { category: 'cyber', applies: true, reasoning: 'r1', estimated_risk_count: 3 },
            { category: 'fire', applies: true, reasoning: 'r2', estimated_risk_count: 2 },
          ],
        },
        categories_applicable: ['cyber', 'fire'],
        categories_skipped: [],
        categories_failed: [{ category: 'fire', error: 'AI service error: 502' }],
        ...overrides,
      };
    }

    it('throws 404 when the run does not exist or belongs to another org', async () => {
      runDb.findFirst.mockResolvedValue(null);

      await expect(
        ai_risk_analysis_service.retry_ai_risk_analysis(makeReq({ params: { id: 'run-1' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 409 when the run is still running', async () => {
      runDb.findFirst.mockResolvedValue(makeFailedRun({ status: 'running' }));

      await expect(
        ai_risk_analysis_service.retry_ai_risk_analysis(makeReq({ params: { id: 'run-1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(runDb.update).not.toHaveBeenCalled();
    });

    it('throws 400 when the run has no failed categories', async () => {
      runDb.findFirst.mockResolvedValue(makeFailedRun({ categories_failed: [] }));

      await expect(
        ai_risk_analysis_service.retry_ai_risk_analysis(makeReq({ params: { id: 'run-1' } })),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(runDb.update).not.toHaveBeenCalled();
    });

    // Review finding: two near-simultaneous retry requests could both pass
    // the `run.status === 'running'` check above before either commits --
    // the guarded updateMany (only applies when status is still NOT
    // 'running' at write time) is what actually prevents the second one
    // from winning. Simulated here by having it report count: 0, as a real
    // race loser would.
    it('throws 409 when a concurrent retry already won the race to flip status to running', async () => {
      runDb.findFirst.mockResolvedValue(makeFailedRun());
      siteDb.findFirst.mockResolvedValue(SITE);
      runDb.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        ai_risk_analysis_service.retry_ai_risk_analysis(makeReq({ params: { id: 'run-1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(runDb.updateMany).toHaveBeenCalledWith({
        where: { id: 'run-1', status: { not: 'running' } },
        data: { status: 'running' },
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("throws 404 when the run's site no longer exists in the org", async () => {
      runDb.findFirst.mockResolvedValue(makeFailedRun());
      siteDb.findFirst.mockResolvedValue(null);

      await expect(
        ai_risk_analysis_service.retry_ai_risk_analysis(makeReq({ params: { id: 'run-1' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('sets the run back to running and returns immediately without waiting for the retry', async () => {
      runDb.findFirst.mockResolvedValue(makeFailedRun());
      siteDb.findFirst.mockResolvedValue(SITE);
      runDb.update.mockResolvedValue(makeFailedRun({ status: 'running' }));
      runDb.findUniqueOrThrow.mockResolvedValue(makeFailedRun({ status: 'running' }));
      runDb.findUnique.mockResolvedValue(makeFailedRun());
      // Never resolves -- proves retry_ai_risk_analysis doesn't await the
      // actual retry work, same fire-and-forget contract as
      // start_ai_risk_analysis.
      (fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

      const result = await ai_risk_analysis_service.retry_ai_risk_analysis(
        makeReq({ params: { id: 'run-1' } }),
      );

      expect(result).toMatchObject({ status: 'running' });
      expect(runDb.updateMany).toHaveBeenCalledWith({
        where: { id: 'run-1', status: { not: 'running' } },
        data: { status: 'running' },
      });

      // Drains retryFailedCategories' pending background work (the
      // Prisma-backed steps before the actual fetch() call, plus the
      // delay(0) stagger timer) up to the point it genuinely hangs
      // forever on the never-resolving fetch mock -- without this, that
      // work can straddle into the NEXT test's timer queue and fire
      // there once THAT test swaps in a resolving fetch mock, silently
      // double-creating a risk in an unrelated test (found by exactly
      // that failure while writing this test).
      await flush();
    });

    it('retries only the failed category, updates the same run row to completed on success, and creates no duplicate run', async () => {
      runDb.findFirst.mockResolvedValue(makeFailedRun());
      siteDb.findFirst.mockResolvedValue(SITE);
      runDb.update.mockResolvedValue(makeFailedRun({ status: 'running' }));
      runDb.findUniqueOrThrow.mockResolvedValue(makeFailedRun({ status: 'running' }));
      runDb.findUnique.mockResolvedValue(makeFailedRun());
      frameworkDb.findMany.mockResolvedValue([]);

      (fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string, init?: RequestInit) => {
        if (url.endsWith('/risk_category_generation')) {
          const body = JSON.parse((init?.body as string) ?? '{}');
          // Only the previously-failed category should ever be retried --
          // 'cyber' already succeeded on the original run and must not be
          // re-called.
          expect(body.category).toBe('fire');
          return Promise.resolve(
            mockAiResponse({
              risks: [
                {
                  name: 'Fire safety gap',
                  description: 'desc',
                  applicability_reasoning: 'reason',
                  legal_status: 'active_statutory',
                  regulatory_official_reference: null,
                  regulatory_citation_note: null,
                  citation_confidence: 'none',
                  probability: 40,
                  impact: 50,
                  financial_impact_min: 20,
                  financial_impact_max: 200,
                  velocity: 'medium',
                  trend: 'none',
                  control_design_eff: 40,
                  control_operating_eff: 40,
                  internal_pilot: null,
                },
              ],
            }),
          );
        }
        return Promise.resolve(mockAiResponse({}, false, 404));
      });

      await ai_risk_analysis_service.retry_ai_risk_analysis(makeReq({ params: { id: 'run-1' } }));
      await flush();

      // create is called at most once, on the run row -- no second
      // AiRiskAnalysisRun ever created by a retry.
      expect(runDb.create).not.toHaveBeenCalled();
      expect(riskDb.create).toHaveBeenCalledTimes(1);

      const finalUpdateCall = runDb.update.mock.calls[runDb.update.mock.calls.length - 1][0];
      expect(finalUpdateCall.where).toEqual({ id: 'run-1' });
      expect(finalUpdateCall.data.status).toBe('completed');
      expect(finalUpdateCall.data.categories_failed).toEqual([]);
    });

    it('keeps a category that fails again in categories_failed, staying partial', async () => {
      runDb.findFirst.mockResolvedValue(makeFailedRun());
      siteDb.findFirst.mockResolvedValue(SITE);
      runDb.update.mockResolvedValue(makeFailedRun({ status: 'running' }));
      runDb.findUniqueOrThrow.mockResolvedValue(makeFailedRun({ status: 'running' }));
      runDb.findUnique.mockResolvedValue(makeFailedRun());
      frameworkDb.findMany.mockResolvedValue([]);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockAiResponse({}, false, 502));

      await ai_risk_analysis_service.retry_ai_risk_analysis(makeReq({ params: { id: 'run-1' } }));
      await flush();

      const finalUpdateCall = runDb.update.mock.calls[runDb.update.mock.calls.length - 1][0];
      expect(finalUpdateCall.data.status).toBe('partial');
      expect(finalUpdateCall.data.categories_failed).toEqual([
        expect.objectContaining({ category: 'fire' }),
      ]);
    });

    // Review finding: retryFailedCategories used to only ever produce
    // 'completed'/'partial', never 'failed' -- if literally every category
    // the run ever attempted still has zero successes after the retry, the
    // run should read as 'failed' again, not a misleadingly less-severe
    // 'partial'. categories_applicable here has only the one category that
    // keeps failing, so a 0-success retry means 0 of 0-other successes too.
    it("marks the run 'failed' again when the retry doesn't fix the run's only category and nothing else ever succeeded", async () => {
      runDb.findFirst.mockResolvedValue(
        makeFailedRun({
          status: 'failed',
          categories_applicable: ['fire'],
          categories_failed: [{ category: 'fire', error: 'AI service error: 502' }],
        }),
      );
      siteDb.findFirst.mockResolvedValue(SITE);
      runDb.update.mockResolvedValue(makeFailedRun({ status: 'running' }));
      runDb.findUniqueOrThrow.mockResolvedValue(makeFailedRun({ status: 'running' }));
      runDb.findUnique.mockResolvedValue(
        makeFailedRun({
          categories_applicable: ['fire'],
          categories_failed: [{ category: 'fire', error: 'AI service error: 502' }],
        }),
      );
      frameworkDb.findMany.mockResolvedValue([]);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockAiResponse({}, false, 502));

      await ai_risk_analysis_service.retry_ai_risk_analysis(makeReq({ params: { id: 'run-1' } }));
      await flush();

      const finalUpdateCall = runDb.update.mock.calls[runDb.update.mock.calls.length - 1][0];
      expect(finalUpdateCall.data.status).toBe('failed');
    });

    it('keeps a failed-category record whose category no longer exists in the stored triage result, never silently dropping it', async () => {
      runDb.findFirst.mockResolvedValue(
        makeFailedRun({
          categories_failed: [{ category: 'atex', error: 'AI service error: 502' }],
        }),
      );
      siteDb.findFirst.mockResolvedValue(SITE);
      runDb.update.mockResolvedValue(makeFailedRun({ status: 'running' }));
      runDb.findUniqueOrThrow.mockResolvedValue(makeFailedRun({ status: 'running' }));
      runDb.findUnique.mockResolvedValue(
        makeFailedRun({
          categories_failed: [{ category: 'atex', error: 'AI service error: 502' }],
        }),
      );
      frameworkDb.findMany.mockResolvedValue([]);

      await ai_risk_analysis_service.retry_ai_risk_analysis(makeReq({ params: { id: 'run-1' } }));
      await flush();

      expect(fetch).not.toHaveBeenCalled();
      const finalUpdateCall = runDb.update.mock.calls[runDb.update.mock.calls.length - 1][0];
      expect(finalUpdateCall.data.status).toBe('partial');
      expect(finalUpdateCall.data.categories_failed).toEqual([
        expect.objectContaining({ category: 'atex' }),
      ]);
    });
  });
});
