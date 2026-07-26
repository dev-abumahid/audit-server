import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

// setup.ts sets AI_INTERNAL_SECRET = 'test-ai-internal-secret' before any
// config import — the exact secret mintOrgToken signs the X-Org-Token with.
const jwtDecode = (token: string) => jwt.verify(token, 'test-ai-internal-secret') as jwt.JwtPayload;

vi.mock('../../app/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    report: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    organizationProfile: { findUnique: vi.fn() },
    risk: { findMany: vi.fn() },
    riskApproval: { findMany: vi.fn() },
    kri: { findMany: vi.fn() },
    site: { findMany: vi.fn() },
    action: { findMany: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
  },
}));

// Puppeteer render and the S3/Cloudinary upload are the two heavy external
// steps in the generate pipeline — mock both so the orchestration can be
// tested without launching Chromium or hitting object storage.
vi.mock('../../app/utils/report_pdf.js', () => ({
  renderReportPdf: vi.fn(),
}));
vi.mock('../../app/utils/cloudinary.js', () => ({
  default: vi.fn(),
  getSignedDownloadUrl: vi.fn(),
}));

import { prisma } from '../../app/lib/prisma.js';
import uploadCloud, { getSignedDownloadUrl } from '../../app/utils/cloudinary.js';
import { renderReportPdf } from '../../app/utils/report_pdf.js';
import { report_service } from '../../app/modules/report/report.service.js';

const reportDb = prisma.report as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const profileDb = prisma.organizationProfile as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskDb = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskApprovalDb = prisma.riskApproval as unknown as Record<string, ReturnType<typeof vi.fn>>;
const kriDb = prisma.kri as unknown as Record<string, ReturnType<typeof vi.fn>>;
const siteDb = prisma.site as unknown as Record<string, ReturnType<typeof vi.fn>>;
const actionDb = prisma.action as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockRender = renderReportPdf as unknown as ReturnType<typeof vi.fn>;
const mockUpload = uploadCloud as unknown as ReturnType<typeof vi.fn>;
const mockSignedUrl = getSignedDownloadUrl as unknown as ReturnType<typeof vi.fn>;

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

const AI_CONTENT = {
  title: 'Board Risk Report',
  subtitle: 'Q3 2026',
  reference: 'BOARD-2026-Q3',
  classification: 'Confidential',
  executive_summary: 'Summary.',
  organization_summary: {
    name: 'Acme',
    site_count: 1,
    risk_count: 1,
    kri_count: 0,
    open_action_count: 0,
    narrative: 'Narrative.',
  },
  top_risks: [],
  kri_dashboard: [],
  open_actions: [],
  outlook: 'Outlook.',
};

const primeOrgDataMocks = () => {
  profileDb.findUnique.mockResolvedValue({ organizationName: 'Acme' });
  riskDb.findMany.mockResolvedValue([]);
  riskApprovalDb.findMany.mockResolvedValue([]);
  kriDb.findMany.mockResolvedValue([]);
  siteDb.findMany.mockResolvedValue([]);
  actionDb.findMany.mockResolvedValue([]);
};

// A minimal Risk row shaped like prisma.risk.findMany(include: { site }) output
// — only the fields fetchOrgData reads. `site` is the included relation object.
const makeRisk = (id: string, name: string) => ({
  id,
  name,
  category: 'OPERATIONAL',
  site: { name: 'HQ' },
  inherent_score: 12,
  residual_score: 8,
  status: 'OPEN',
  trend: 'STABLE',
  velocity: 'SLOW',
  probability: 3,
  financial_impact_min: 1000,
  financial_impact_max: 5000,
});

// Resolves the fetch mock so the report pipeline (fetch -> render -> upload)
// runs end to end, capturing the JSON body sent to aexa-ai and returning
// `aiContent` as the AI's structured response.
const primeSuccessfulPipeline = (aiContent: Record<string, unknown>) => {
  reportDb.create.mockResolvedValue({ id: 'rep-1', title: 'Board Risk Report' });
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue(aiContent),
  });
  mockRender.mockResolvedValue(Buffer.from('%PDF-1.7'));
  mockUpload.mockResolvedValue({ secure_url: 'https://cdn.example/report.pdf', key: 'k' });
  reportDb.update.mockResolvedValue({ id: 'rep-1', status: 'READY' });
};

// The JSON body posted to aexa-ai's /report_content, i.e. the PipelineInput.
const aiRequestBody = () =>
  JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);

describe('report service — org scoping (issue #94)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    // Default: no OrgMember row — ADMIN-of-self fallback, same convention as
    // every sibling service test.
    orgMemberDb.findUnique.mockResolvedValue(null);
    // Default: no in-flight GENERATING report (concurrency guard #219) and a
    // no-op stale sweep (#221), so tests not exercising those paths are unaffected.
    reportDb.findFirst.mockResolvedValue(null);
    reportDb.updateMany.mockResolvedValue({ count: 0 });
  });

  describe('get_all_report_from_db', () => {
    it('filters findMany and count by caller org', async () => {
      reportDb.findMany.mockResolvedValue([]);
      reportDb.count.mockResolvedValue(0);

      await report_service.get_all_report_from_db(makeReq({ query: {} }));

      expect(reportDb.findMany.mock.calls[0][0].where).toMatchObject({ org_account_id: ORG_A });
      expect(reportDb.count.mock.calls[0][0].where).toMatchObject({ org_account_id: ORG_A });
    });

    it('includes totalPage in meta via the shared pagination helper', async () => {
      reportDb.findMany.mockResolvedValue([]);
      reportDb.count.mockResolvedValue(23);

      const result = await report_service.get_all_report_from_db(
        makeReq({ query: { page: '2', limit: '10' } }),
      );

      expect(result.meta).toEqual({ page: 2, limit: 10, skip: 10, total: 23, totalPage: 3 });
    });

    it('sweeps stale GENERATING rows to FAILED before returning the list (#221)', async () => {
      reportDb.findMany.mockResolvedValue([]);
      reportDb.count.mockResolvedValue(0);

      await report_service.get_all_report_from_db(makeReq({ query: {} }));

      expect(reportDb.updateMany).toHaveBeenCalledTimes(1);
      const sweep = reportDb.updateMany.mock.calls[0][0];
      // Only this org's stale GENERATING rows are targeted, and only ones older
      // than the staleness cutoff — an in-flight generation is never reaped.
      expect(sweep.where).toMatchObject({ org_account_id: ORG_A, status: 'GENERATING' });
      expect(sweep.where.updatedAt.lt).toBeInstanceOf(Date);
      expect(sweep.where.updatedAt.lt.getTime()).toBeLessThan(Date.now());
      expect(sweep.data.status).toBe('FAILED');
      expect(sweep.data.error_message).toBeTruthy();
    });

    it('still returns the list if the stale sweep throws (best-effort reaper)', async () => {
      reportDb.updateMany.mockRejectedValue(new Error('db blip'));
      reportDb.findMany.mockResolvedValue([]);
      reportDb.count.mockResolvedValue(0);

      await expect(
        report_service.get_all_report_from_db(makeReq({ query: {} })),
      ).resolves.toBeDefined();
      expect(reportDb.findMany).toHaveBeenCalled();
    });
  });

  describe('get_single_report_from_db', () => {
    it('scopes the lookup by org', async () => {
      reportDb.findUnique.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });

      await report_service.get_single_report_from_db(makeReq({ params: { id: 'r1' } }));

      expect(reportDb.findUnique).toHaveBeenCalledWith({
        where: { id: 'r1', org_account_id: ORG_A },
      });
    });

    it('throws 404 for a cross-org / missing report instead of returning null', async () => {
      reportDb.findUnique.mockResolvedValue(null);

      await expect(
        report_service.get_single_report_from_db(makeReq({ params: { id: 'org-b-report' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('generate_report_into_db — write-path role scoping', () => {
    it('VIEWER cannot generate a report', async () => {
      mockMembership('VIEWER');

      await expect(
        report_service.generate_report_into_db(makeReq({ body: {} })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(reportDb.create).not.toHaveBeenCalled();
    });

    it('rejects an unsupported report type without creating a row', async () => {
      await expect(
        report_service.generate_report_into_db(makeReq({ body: { type: 'AUDIT_OPINION' } })),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(reportDb.create).not.toHaveBeenCalled();
    });
  });

  describe('generate_report_into_db — per-org concurrency guard (#219)', () => {
    it('returns 409 and creates no row when the org already has a GENERATING report', async () => {
      reportDb.findFirst.mockResolvedValue({ id: 'in-flight' });

      await expect(
        report_service.generate_report_into_db(makeReq({ body: {} })),
      ).rejects.toMatchObject({ statusCode: 409 });

      // Guard is scoped to the caller's org and its GENERATING status.
      expect(reportDb.findFirst.mock.calls[0][0].where).toMatchObject({
        org_account_id: ORG_A,
        status: 'GENERATING',
      });
      // No second Chromium pipeline is launched while one is already in flight.
      expect(reportDb.create).not.toHaveBeenCalled();
    });

    it('proceeds to create a row when no GENERATING report exists', async () => {
      primeOrgDataMocks();
      reportDb.findFirst.mockResolvedValue(null);
      reportDb.create.mockResolvedValue({ id: 'rep-1', title: 'x' });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(AI_CONTENT),
      });
      mockRender.mockResolvedValue(Buffer.from('%PDF'));
      mockUpload.mockResolvedValue({ secure_url: 'https://cdn/x.pdf', key: 'k' });
      reportDb.update.mockResolvedValue({ id: 'rep-1', status: 'READY' });

      await report_service.generate_report_into_db(makeReq({ body: {} }));

      expect(reportDb.create).toHaveBeenCalled();
    });

    it('sends a signed org-identity token on the aexa-ai call so per-org limiting applies (#219, superseded by #56)', async () => {
      primeOrgDataMocks();
      reportDb.create.mockResolvedValue({ id: 'rep-1', title: 'x' });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(AI_CONTENT),
      });
      mockRender.mockResolvedValue(Buffer.from('%PDF'));
      mockUpload.mockResolvedValue({ secure_url: 'https://cdn/x.pdf', key: 'k' });
      reportDb.update.mockResolvedValue({});

      await report_service.generate_report_into_db(makeReq({ body: {} }));

      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      // Issue #56: the old plain, self-reported X-Organization header is
      // replaced by a signed, verifiable org-identity token — aexa-ai's
      // limiter can no longer be fooled by a caller rotating a header value.
      expect(init.headers['X-Organization']).toBeUndefined();
      expect(init.headers).toHaveProperty('X-Org-Token');
      const payload = jwtDecode(init.headers['X-Org-Token']);
      expect(payload.org_account_id).toBe(ORG_A);
    });
  });

  describe('generate_report_into_db — success path', () => {
    it('creates GENERATING, runs the pipeline, and updates to READY with content + file_url', async () => {
      primeOrgDataMocks();
      reportDb.create.mockResolvedValue({ id: 'rep-1', title: 'Board Risk Report' });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(AI_CONTENT),
      });
      mockRender.mockResolvedValue(Buffer.from('%PDF-1.7'));
      mockUpload.mockResolvedValue({ secure_url: 'https://cdn.example/report.pdf', key: 'k' });
      reportDb.update.mockResolvedValue({ id: 'rep-1', status: 'READY' });

      const result = await report_service.generate_report_into_db(makeReq({ body: {} }));

      // Row created at GENERATING first.
      expect(reportDb.create.mock.calls[0][0].data).toMatchObject({
        org_account_id: ORG_A,
        status: 'GENERATING',
        generated_by: ORG_A,
      });
      // aexa-ai was called, PDF rendered, uploaded.
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/report_content'),
        expect.anything(),
      );
      expect(mockRender).toHaveBeenCalledWith(AI_CONTENT);
      expect(mockUpload).toHaveBeenCalled();
      // Final update transitions to READY with the artifact + content.
      const updateArg = reportDb.update.mock.calls[0][0];
      expect(updateArg.data).toMatchObject({
        status: 'READY',
        file_url: 'https://cdn.example/report.pdf',
        reference: 'BOARD-2026-Q3',
      });
      expect(result).toMatchObject({ status: 'READY' });
    });

    it('forwards the X-Internal-Secret header on the aexa-ai call', async () => {
      primeOrgDataMocks();
      reportDb.create.mockResolvedValue({ id: 'rep-1', title: 'x' });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(AI_CONTENT),
      });
      mockRender.mockResolvedValue(Buffer.from('%PDF'));
      mockUpload.mockResolvedValue({ secure_url: 'https://cdn/x.pdf', key: 'k' });
      reportDb.update.mockResolvedValue({});

      await report_service.generate_report_into_db(makeReq({ body: {} }));

      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.headers).toHaveProperty('X-Internal-Secret');
    });
  });

  describe('generate_report_into_db — failure marks status FAILED', () => {
    it('marks the row FAILED (not stuck GENERATING) when aexa-ai errors', async () => {
      primeOrgDataMocks();
      reportDb.create.mockResolvedValue({ id: 'rep-1', title: 'x' });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 502 });
      reportDb.update.mockResolvedValue({ id: 'rep-1', status: 'FAILED' });

      const result = await report_service.generate_report_into_db(makeReq({ body: {} }));

      const updateArg = reportDb.update.mock.calls[0][0];
      expect(updateArg.data.status).toBe('FAILED');
      expect(updateArg.data.error_message).toBeTruthy();
      // Generic message — no raw upstream detail leaked.
      expect(updateArg.data.error_message).not.toContain('502');
      expect(result).toMatchObject({ status: 'FAILED' });
      expect(mockRender).not.toHaveBeenCalled();
    });

    it('marks the row FAILED when Puppeteer render throws', async () => {
      primeOrgDataMocks();
      reportDb.create.mockResolvedValue({ id: 'rep-1', title: 'x' });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(AI_CONTENT),
      });
      mockRender.mockRejectedValue(new Error('Chromium crashed at /internal/path'));
      reportDb.update.mockResolvedValue({ id: 'rep-1', status: 'FAILED' });

      const result = await report_service.generate_report_into_db(makeReq({ body: {} }));

      expect(reportDb.update.mock.calls[0][0].data.status).toBe('FAILED');
      // Raw internal error text must not reach the persisted (client-visible) message.
      expect(reportDb.update.mock.calls[0][0].data.error_message).not.toContain('/internal/path');
      expect(result).toMatchObject({ status: 'FAILED' });
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('marks the row FAILED when the upload fails', async () => {
      primeOrgDataMocks();
      reportDb.create.mockResolvedValue({ id: 'rep-1', title: 'x' });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(AI_CONTENT),
      });
      mockRender.mockResolvedValue(Buffer.from('%PDF'));
      mockUpload.mockRejectedValue(new Error('S3 upload failed'));
      reportDb.update.mockResolvedValue({ id: 'rep-1', status: 'FAILED' });

      const result = await report_service.generate_report_into_db(makeReq({ body: {} }));

      expect(reportDb.update.mock.calls[0][0].data.status).toBe('FAILED');
      expect(result).toMatchObject({ status: 'FAILED' });
    });
  });

  describe('download_report_from_db', () => {
    it('returns a short-lived signed URL for a READY report, not the raw permanent one (#222)', async () => {
      const PERMANENT = 'https://bucket.s3.eu-west-1.amazonaws.com/1700000000-report.pdf';
      const SIGNED = `${PERMANENT}?X-Amz-Signature=abc&X-Amz-Expires=300`;
      reportDb.findUnique.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        status: 'READY',
        file_url: PERMANENT,
      });
      mockSignedUrl.mockResolvedValue(SIGNED);

      const result = await report_service.download_report_from_db(
        makeReq({ params: { id: 'r1' } }),
      );

      // The permanent stored URL is signed at request time with a finite TTL.
      expect(mockSignedUrl).toHaveBeenCalledWith(PERMANENT, expect.any(Number));
      // The client receives the signed (time-limited) URL, never the raw one.
      expect(result.file_url).toBe(SIGNED);
      expect(result.file_url).not.toBe(PERMANENT);
      expect(result.expires_in).toBeGreaterThan(0);
    });

    it('throws 404 for a cross-org / missing report', async () => {
      reportDb.findUnique.mockResolvedValue(null);

      await expect(
        report_service.download_report_from_db(makeReq({ params: { id: 'org-b' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 409 when the report is still GENERATING', async () => {
      reportDb.findUnique.mockResolvedValue({
        id: 'r1',
        org_account_id: ORG_A,
        status: 'GENERATING',
        file_url: null,
      });

      await expect(
        report_service.download_report_from_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('publish_report_into_db — admin gate + state machine', () => {
    it('non-admin (LEAD_AUDITOR) cannot publish', async () => {
      mockMembership('LEAD_AUDITOR');

      await expect(
        report_service.publish_report_into_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(reportDb.update).not.toHaveBeenCalled();
    });

    it('admin publishing a READY report transitions it to PUBLISHED and stamps reviewer', async () => {
      mockMembership('ADMIN');
      reportDb.findUnique.mockResolvedValue({ id: 'r1', org_account_id: ANCHOR, status: 'READY' });
      reportDb.update.mockResolvedValue({ id: 'r1', status: 'PUBLISHED' });

      await report_service.publish_report_into_db(makeReq({ params: { id: 'r1' } }));

      const updateArg = reportDb.update.mock.calls[0][0];
      expect(updateArg.data.status).toBe('PUBLISHED');
      expect(updateArg.data.reviewed_by).toBe(ORG_A);
      expect(updateArg.data.reviewed_at).toBeInstanceOf(Date);
    });

    it('throws 409 when the report is not in READY state (e.g. already PUBLISHED)', async () => {
      mockMembership('ADMIN');
      reportDb.findUnique.mockResolvedValue({
        id: 'r1',
        org_account_id: ANCHOR,
        status: 'PUBLISHED',
      });

      await expect(
        report_service.publish_report_into_db(makeReq({ params: { id: 'r1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(reportDb.update).not.toHaveBeenCalled();
    });

    it('throws 404 for a cross-org report id', async () => {
      mockMembership('ADMIN');
      reportDb.findUnique.mockResolvedValue(null);

      await expect(
        report_service.publish_report_into_db(makeReq({ params: { id: 'org-b' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // aexa-frontend#164: risk approval must have a downstream effect on Reports.
  // Decision (Omar): do NOT hard-gate on APPROVED. Exclude only risks with a
  // live REJECTED approval, and annotate every included risk with its state.
  describe('generate_report_into_db — risk approval filter + annotation (#164)', () => {
    beforeEach(() => {
      primeOrgDataMocks();
    });

    // An AI response whose top_risks echo the given refs (aexa-ai preserves
    // each risk's ref when it reshapes the input into top_risks).
    const aiEcho = (refs: string[]) => ({
      ...AI_CONTENT,
      top_risks: refs.map((ref) => ({
        ref,
        title: `Risk ${ref}`,
        category: 'OPERATIONAL',
        site: 'HQ',
        inherent_score: 12,
        residual_score: 8,
        trend: 'STABLE',
        commentary: '',
      })),
    });

    it('excludes a live-REJECTED risk and labels every other risk by its live state', async () => {
      riskDb.findMany.mockResolvedValue([
        makeRisk('approved-1111', 'Approved Risk'),
        makeRisk('pending0-1111', 'Pending Risk'),
        makeRisk('none0000-1111', 'Unsubmitted Risk'),
        makeRisk('rejected-1111', 'Rejected Risk'),
        makeRisk('invalid0-1111', 'Invalidated Risk'),
      ]);
      // Returned newest-first, as prisma orderBy createdAt desc would. The
      // approved risk carries an OLDER rejected cycle too — proving latest-wins
      // (a risk rejected then resubmitted+approved is included, not excluded).
      riskApprovalDb.findMany.mockResolvedValue([
        { riskId: 'approved-1111', status: 'APPROVED', invalidatedAt: null },
        { riskId: 'approved-1111', status: 'REJECTED', invalidatedAt: null },
        { riskId: 'pending0-1111', status: 'PENDING_APPROVAL', invalidatedAt: null },
        { riskId: 'rejected-1111', status: 'REJECTED', invalidatedAt: null },
        // Latest cycle was APPROVED but the risk was edited afterwards
        // (invalidatedAt set) — must revert to NOT_SUBMITTED, NOT be excluded.
        { riskId: 'invalid0-1111', status: 'APPROVED', invalidatedAt: new Date() },
        // none0000 has no approval cycle at all -> NOT_SUBMITTED.
      ]);
      // AI echoes the four surviving refs.
      primeSuccessfulPipeline(aiEcho(['approved', 'pending0', 'none0000', 'invalid0']));

      await report_service.generate_report_into_db(makeReq({ body: {} }));

      // The AI payload excludes the rejected risk and — critically — carries NO
      // approval_status on any risk (aexa-ai's ReportRiskInput is extra=forbid,
      // so an approval label in the payload would 422 the whole generation).
      const body = aiRequestBody();
      expect(body.risks).toHaveLength(4);
      expect(body.risks.map((r: { name: string }) => r.name)).not.toContain('Rejected Risk');
      for (const r of body.risks) expect(r).not.toHaveProperty('approval_status');

      // The label is instead joined onto the AI's output before render — every
      // surviving risk carries its correct live label; the rejected one is absent.
      const rendered = mockRender.mock.calls[0][0];
      const byRef: Record<string, { approval_status?: string }> = {};
      for (const r of rendered.top_risks) byRef[r.ref] = r;
      expect(byRef['approved'].approval_status).toBe('APPROVED');
      expect(byRef['pending0'].approval_status).toBe('PENDING_APPROVAL');
      expect(byRef['none0000'].approval_status).toBe('NOT_SUBMITTED');
      expect(byRef['invalid0'].approval_status).toBe('NOT_SUBMITTED');
      expect(byRef['rejected']).toBeUndefined();
    });

    it('queries approval cycles only for the org’s own risks', async () => {
      riskDb.findMany.mockResolvedValue([makeRisk('approved-1111', 'Approved Risk')]);
      riskApprovalDb.findMany.mockResolvedValue([
        { riskId: 'approved-1111', status: 'APPROVED', invalidatedAt: null },
      ]);
      primeSuccessfulPipeline(AI_CONTENT);

      await report_service.generate_report_into_db(makeReq({ body: {} }));

      expect(riskApprovalDb.findMany.mock.calls[0][0].where).toEqual({
        riskId: { in: ['approved-1111'] },
      });
    });

    it('does not query approvals when the org has no risks', async () => {
      riskDb.findMany.mockResolvedValue([]);
      primeSuccessfulPipeline(AI_CONTENT);

      await report_service.generate_report_into_db(makeReq({ body: {} }));

      expect(riskApprovalDb.findMany).not.toHaveBeenCalled();
    });

    it('joins the approval label onto the AI’s top_risks output by ref before render', async () => {
      riskDb.findMany.mockResolvedValue([
        makeRisk('approved-1111', 'Approved Risk'),
        makeRisk('pending0-1111', 'Pending Risk'),
      ]);
      riskApprovalDb.findMany.mockResolvedValue([
        { riskId: 'approved-1111', status: 'APPROVED', invalidatedAt: null },
        { riskId: 'pending0-1111', status: 'PENDING_APPROVAL', invalidatedAt: null },
      ]);
      // The AI echoes each risk's ref in its reshaped top_risks, plus one ref
      // that maps to nothing (hallucination) — that one must stay unlabeled.
      const aiContent = {
        ...AI_CONTENT,
        top_risks: [
          {
            ref: 'approved',
            title: 'Approved Risk',
            category: 'OPERATIONAL',
            site: 'HQ',
            inherent_score: 12,
            residual_score: 8,
            trend: 'STABLE',
            commentary: '',
          },
          {
            ref: 'pending0',
            title: 'Pending Risk',
            category: 'OPERATIONAL',
            site: 'HQ',
            inherent_score: 12,
            residual_score: 8,
            trend: 'STABLE',
            commentary: '',
          },
          {
            ref: 'ghost123',
            title: 'Ghost',
            category: 'X',
            site: 'HQ',
            inherent_score: 1,
            residual_score: 1,
            trend: 'STABLE',
            commentary: '',
          },
        ],
      };
      primeSuccessfulPipeline(aiContent);

      await report_service.generate_report_into_db(makeReq({ body: {} }));

      const rendered = mockRender.mock.calls[0][0];
      const byRef: Record<string, { approval_status?: string }> = {};
      for (const r of rendered.top_risks) byRef[r.ref] = r;

      expect(byRef['approved'].approval_status).toBe('APPROVED');
      expect(byRef['pending0'].approval_status).toBe('PENDING_APPROVAL');
      // Unmapped ref is left unlabeled rather than guessed.
      expect(byRef['ghost123'].approval_status).toBeUndefined();
    });
  });

  // Methodology audit finding: the AI is never told compute_kri_status's
  // formula or which direction each indicator runs, so its own guessed
  // kri_dashboard status could disagree with what the live KRI Dashboard
  // shows for the exact same numbers. Recomputed deterministically from the
  // same three numbers the AI already echoed back, same
  // "keep authoritative data out of the LLM's hands" pattern as the
  // approval-status annotation above.
  describe('generate_report_into_db — KRI status is recomputed, not trusted from the AI (methodology audit)', () => {
    beforeEach(() => {
      primeOrgDataMocks();
    });

    it('overrides an AI-guessed status with the real compute_kri_status result, for both KRI directions', async () => {
      const aiContent = {
        ...AI_CONTENT,
        kri_dashboard: [
          // "Higher is better" (target above threshold): current 90 is
          // above target 80 -> real status is OK, AI guessed "breached".
          {
            name: 'Compliance Coverage %',
            unit: '%',
            current_value: 90,
            target_value: 80,
            alert_threshold: 50,
            status: 'breached',
            commentary: 'On track.',
          },
          // "Lower is better" (target below threshold): current 45 is at/above
          // the 40 alert_threshold -> real status is ALERT, AI guessed "on_track".
          {
            name: 'Supplier Lead Time',
            unit: 'days',
            current_value: 45,
            target_value: 10,
            alert_threshold: 40,
            status: 'on_track',
            commentary: 'Looking fine.',
          },
        ],
      };
      primeSuccessfulPipeline(aiContent);

      await report_service.generate_report_into_db(makeReq({ body: {} }));

      const rendered = mockRender.mock.calls[0][0];
      const byName: Record<string, { status: string }> = {};
      for (const k of rendered.kri_dashboard) byName[k.name] = k;

      expect(byName['Compliance Coverage %'].status).toBe('OK');
      expect(byName['Supplier Lead Time'].status).toBe('ALERT');
    });

    // Round-1 review gap: content is only ever typed `as ReportContent` on
    // the raw AI response (callReportContentAi) -- nothing guarantees the
    // AI actually echoed back real numbers. Before this fix, a missing or
    // non-numeric current_value made every compute_kri_status comparison
    // involve NaN (always false), silently falling through to a real
    // status value ('WARNING') indistinguishable from a genuinely-computed
    // one. Must resolve to the explicit 'UNKNOWN' sentinel instead, so a
    // malformed AI response is visibly flagged rather than misreported as
    // a real status.
    it('marks a KRI UNKNOWN instead of a fake WARNING when the AI omits/mangles a required number', async () => {
      const aiContent = {
        ...AI_CONTENT,
        kri_dashboard: [
          // Missing current_value entirely.
          {
            name: 'Missing Current Value',
            unit: '%',
            target_value: 80,
            alert_threshold: 50,
            status: 'on_track',
            commentary: 'AI omitted current_value.',
          },
          // Non-numeric current_value.
          {
            name: 'Non-Numeric Current Value',
            unit: 'days',
            current_value: 'high',
            target_value: 10,
            alert_threshold: 40,
            status: 'breached',
            commentary: 'AI sent a string instead of a number.',
          },
          // A genuinely well-formed KRI in the same response, to prove the
          // guard is scoped to the malformed entries only.
          {
            name: 'Well-Formed KRI',
            unit: '%',
            current_value: 90,
            target_value: 80,
            alert_threshold: 50,
            status: 'breached',
            commentary: 'Should still compute normally.',
          },
        ],
      };
      primeSuccessfulPipeline(aiContent);

      await report_service.generate_report_into_db(makeReq({ body: {} }));

      const rendered = mockRender.mock.calls[0][0];
      const byName: Record<string, { status: string }> = {};
      for (const k of rendered.kri_dashboard) byName[k.name] = k;

      expect(byName['Missing Current Value'].status).toBe('UNKNOWN');
      expect(byName['Non-Numeric Current Value'].status).toBe('UNKNOWN');
      expect(byName['Well-Formed KRI'].status).toBe('OK');
    });
  });
});
