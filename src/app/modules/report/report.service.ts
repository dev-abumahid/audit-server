import { Prisma } from '@prisma/client';
import { Request } from 'express';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { configs } from '../../configs/index.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import {
  applyActionScope,
  assertCanWriteOrgResource,
  assertIsOrgAdmin,
  resolveCallerOrgContext,
  type CallerOrgContext,
} from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';
import uploadCloud, { getSignedDownloadUrl } from '../../utils/cloudinary.js';
import {
  renderReportPdf,
  type ReportContent,
  type ReportRiskApprovalStatus,
} from '../../utils/report_pdf.js';
import { buildAiHeaders } from '../ai/ai.service.js';
import { compute_kri_status } from '../kri/kri.service.js';
import {
  deriveApprovalState,
  type RiskApprovalDisplayState,
} from '../risk/risk.approval.service.js';

// Only BOARD is backed by real data today (Risk/KRI/Site/Action). The other 4
// Fullbloom-parity types stay disabled in the UI until their backing models
// (audit engine, compliance, Monte Carlo) mature — reject them here too so the
// API can't be driven past what the UI allows.
const SUPPORTED_TYPE = 'BOARD';

// Explicit route-level budget for POST /report/generate (#220). The whole
// synchronous pipeline (fetch org data -> aexa-ai call -> Puppeteer render ->
// upload) runs in one request/response cycle for this first pass (no BullMQ
// queue yet — documented v1 tradeoff). Enforced by the routeTimeout middleware
// on the route so the client's failure is deterministic and owned by the app
// instead of an upstream proxy's default. Exported so the route wires the exact
// same number the pipeline is designed around.
export const REPORT_ROUTE_TIMEOUT_MS = 120_000;

// We abort the aexa-ai call at 90s so the whole request stays comfortably under
// the 120s route timeout, leaving headroom for render + upload.
const AI_CALL_TIMEOUT_MS = 90_000;

// Staleness threshold for the opportunistic GENERATING sweep (#221). A crash
// (restart / OOM / the catch-block's own update failing) can strand a row at
// GENERATING forever with no reaper. Any GENERATING row not touched within the
// route timeout plus a generous 5-minute grace is treated as dead and swept to
// FAILED on the next list read — well past any request that could still be
// legitimately in flight, so an in-progress generation is never reaped early.
const STALE_GENERATING_MS = REPORT_ROUTE_TIMEOUT_MS + 5 * 60_000;

// Presigned download URLs (#222) are short-lived — long enough for a click to
// resolve into a download, short enough that a leaked URL (referrer, history,
// screenshot) stops working quickly.
const DOWNLOAD_URL_TTL_SECONDS = 300;

type PipelineInput = {
  organization: {
    name: string;
    description: string | null;
    location: string | null;
    website: string | null;
  };
  risks: Array<Record<string, unknown>>;
  kris: Array<Record<string, unknown>>;
  sites: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
};

// fetchOrgData returns the AI payload plus a side-channel map of each included
// risk's approval label, keyed by the risk's `ref`. The label is deliberately
// NOT folded into PipelineInput.risks: aexa-ai's ReportRiskInput is
// `extra="forbid"`, so an unknown field on a risk would 422 the whole
// generation. The label is org-derived and deterministic anyway, so it's
// joined back onto the AI's output post-generation (annotateApprovalStatus)
// rather than round-tripped through the LLM.
type OrgReportData = {
  input: PipelineInput;
  approvalByRef: Map<string, ReportRiskApprovalStatus>;
};

// Statuses that mean "this action is not yet done" — used to count/select the
// open actions a board report cares about.
const OPEN_ACTION_STATUSES = ['TO_DO', 'IN_PROGRESS'];

// Approval states that mean "this figure is safe to include in a board
// document". The maker-checker product decision (aexa-frontend#164) is NOT to
// hard-gate on APPROVED — most risks never enter the optional approval
// workflow, so gating would leave early reports near-empty. Instead we exclude
// only risks an admin has explicitly REJECTED (stating the assessment is
// wrong; carrying it as current fact would mislead), and annotate every
// included risk with its live state so the report stays honest about review
// status. deriveApprovalState already collapses an invalidated (edited-after-
// decision) cycle to NOT_SUBMITTED, so an invalidated approval correctly
// reverts to included-and-labeled rather than being treated as REJECTED.
const REPORT_EXCLUDED_APPROVAL_STATE: RiskApprovalDisplayState = 'REJECTED';

/**
 * Resolves each risk's live approval state from its most recent approval cycle
 * in a single query (no N+1). Returns a Map keyed by risk id. Risks with no
 * approval cycle at all are simply absent from the map and default to
 * NOT_SUBMITTED at the call site.
 */
const fetchLatestApprovalStateByRisk = async (
  riskIds: string[],
): Promise<Map<string, RiskApprovalDisplayState>> => {
  const byRisk = new Map<string, RiskApprovalDisplayState>();
  if (riskIds.length === 0) return byRisk;

  // Newest-first, so the first row seen per riskId is that risk's latest cycle
  // — exactly what get_risk_approval_state uses to derive the display state.
  const approvals = await prisma.riskApproval.findMany({
    where: { riskId: { in: riskIds } },
    orderBy: { createdAt: 'desc' },
    select: { riskId: true, status: true, invalidatedAt: true },
  });
  for (const a of approvals) {
    if (byRisk.has(a.riskId)) continue;
    byRisk.set(a.riskId, deriveApprovalState(a));
  }
  return byRisk;
};

const fetchOrgData = async (ctx: CallerOrgContext): Promise<OrgReportData> => {
  const orgAccountId = ctx.organizationId;

  // Role scoping (issue #289, matching applyActionScope's use at every other
  // Action aggregate call site — governance.service.ts's Three Lines board,
  // action.service.ts's list/detail reads, risk.correlation.service.ts):
  // without this, a report generated by a scoped LEAD_AUDITOR (the only
  // non-ADMIN role assertCanWriteOrgResource lets call generate_report_into_db)
  // would pull every open Action in the org instead of just the ones from
  // their assigned inspections, leaking org-wide finding data into a report
  // they shouldn't have full visibility into.
  const actionWhere = await applyActionScope(
    { orgAccountId, status: { in: OPEN_ACTION_STATUSES as never } },
    ctx,
  );

  const [profile, risks, kris, sites, actions] = await Promise.all([
    prisma.organizationProfile.findUnique({ where: { accountId: orgAccountId } }),
    // docs/design-docs/ai-risk-review-approval-workflow.md
    prisma.risk.findMany({
      where: { org_account_id: orgAccountId, review_status: 'APPROVED' },
      include: { site: { select: { name: true } } },
      orderBy: { residual_score: 'desc' },
    }),
    prisma.kri.findMany({
      // Review finding: the risks query above already excludes
      // PENDING_REVIEW/DISMISSED risks, but this query's joined `risk`
      // relation wasn't filtered by the same condition -- a KRI attached to
      // an unreviewed risk would still surface that risk's name in the
      // report even though the risk itself is excluded from the risks
      // section above. `where` can't filter a required to-one include
      // (Prisma only supports filtering the parent by the relation), so
      // this excludes the KRI row itself when its risk isn't approved --
      // consistent with the report only reflecting confirmed register data.
      where: { org_account_id: orgAccountId, risk: { review_status: 'APPROVED' } },
      include: { risk: { select: { name: true } } },
    }),
    prisma.site.findMany({ where: { org_account_id: orgAccountId } }),
    prisma.action.findMany({
      where: actionWhere,
      include: { site: { select: { name: true } } },
    }),
  ]);

  const approvalByRisk = await fetchLatestApprovalStateByRisk(risks.map((r) => r.id));

  // Exclude live-REJECTED risks entirely, then build the AI payload from the
  // survivors and, in lockstep, the ref -> label side-channel map. REJECTED is
  // impossible past the filter, so every map value is a ReportRiskApprovalStatus.
  const approvalByRef = new Map<string, ReportRiskApprovalStatus>();
  const includedRisks = risks
    .map((r) => ({ risk: r, approval: approvalByRisk.get(r.id) ?? 'NOT_SUBMITTED' }))
    .filter(({ approval }) => approval !== REPORT_EXCLUDED_APPROVAL_STATE);

  const input: PipelineInput = {
    organization: {
      name: profile?.organizationName || 'Organization',
      description: profile?.organizationDescription ?? null,
      location: profile?.organizationLocation ?? null,
      website: profile?.organizationWebsite ?? null,
    },
    risks: includedRisks.map(({ risk: r, approval }) => {
      const ref = r.id.slice(0, 8);
      approvalByRef.set(ref, approval as ReportRiskApprovalStatus);
      // NOTE: no approval_status here — aexa-ai's ReportRiskInput forbids extra
      // fields. The label lives only in approvalByRef and is applied to the
      // AI's output afterwards.
      return {
        ref,
        name: r.name,
        category: r.category,
        site_name: r.site?.name ?? null,
        inherent_score: r.inherent_score,
        residual_score: r.residual_score,
        status: r.status,
        trend: r.trend,
        velocity: r.velocity,
        probability: r.probability,
        financial_impact_min: r.financial_impact_min,
        financial_impact_max: r.financial_impact_max,
      };
    }),
    kris: kris.map((k) => ({
      name: k.name,
      unit: k.unit,
      current_value: k.current_value,
      alert_threshold: k.alert_threshold,
      target_value: k.target_value,
      risk_name: k.risk?.name ?? null,
    })),
    sites: sites.map((s) => ({
      name: s.name,
      location: s.location,
      country: s.country,
      activity: s.activity,
    })),
    actions: actions.map((a) => ({
      title: a.actionTitle,
      priority: a.priority,
      status: a.status,
      due_date: a.dueDate ? a.dueDate.toISOString().slice(0, 10) : null,
      site_name: a.site?.name ?? null,
    })),
  };

  return { input, approvalByRef };
};

const callReportContentAi = async (
  input: PipelineInput,
  organizationId: string,
): Promise<ReportContent> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_CALL_TIMEOUT_MS);
  try {
    const aiResponse = await fetch(`${configs.ai_server_end_point}/report_content`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // aexa-ai's /report_content is @limiter.limit(expensive) and its
        // get_org_key (app/limiter.py) keys that budget on the caller's real
        // org so one org's heavy use can't starve every other org's report
        // generation (#219). Originally sent as the plain, self-reported
        // X-Organization header; issue #56 replaced that with a signed,
        // verified org-identity token (buildAiHeaders) that aexa-ai's
        // limiter now prefers — X-Organization is dropped here since the
        // signed token supersedes it and aexa-ai's fallback chain no longer
        // needs it from this call site.
        ...buildAiHeaders(organizationId),
      },
      body: JSON.stringify({ report_type: SUPPORTED_TYPE, ...input }),
      signal: controller.signal,
    });
    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
    return (await aiResponse.json()) as ReportContent;
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Joins each risk's approval label back onto the AI-generated content
 * (aexa-frontend#164). The AI reshapes/selects the input risks into
 * `top_risks` but preserves each risk's `ref`, so ref is the stable join key —
 * the same key the PDF template already renders. Mutates and returns `content`.
 *
 * Post-generation, template-level annotation (not an AI-prompt change): the
 * label is deterministic org data, so deriving it here keeps it authoritative
 * and out of the LLM's hands. A top_risk whose ref doesn't map (e.g. an AI
 * hallucination) is left unlabeled rather than guessed.
 */
const annotateApprovalStatus = (
  content: ReportContent,
  approvalByRef: Map<string, ReportRiskApprovalStatus>,
): ReportContent => {
  for (const risk of content.top_risks ?? []) {
    const approval = approvalByRef.get(risk.ref);
    if (approval) risk.approval_status = approval;
  }
  return content;
};

/**
 * Same "keep authoritative data out of the LLM's hands" pattern as
 * annotateApprovalStatus, for KRI status. The AI is only ever sent
 * current_value/alert_threshold/target_value (kris in fetchOrgData's
 * PipelineInput) and asked to produce a board narrative around them -- it is
 * never told the app's own three-way OK/WARNING/ALERT formula or which
 * direction each indicator runs (kri.service.ts's compute_kri_status infers
 * "lower is better" vs "higher is better" from target vs threshold), so its
 * guessed status can disagree with what the live KRI Dashboard shows for the
 * exact same numbers. Recomputed here from the same three numbers the AI
 * already echoed back in kri_dashboard, using the one real formula, so the
 * board PDF can never show a different status than the dashboard for
 * identical data.
 *
 * content is only-ever-typed as ReportContent via an unchecked
 * `as ReportContent` on the raw AI response (callReportContentAi) -- nothing
 * actually guarantees the AI echoed back real numbers for the three fields
 * compute_kri_status needs. If any of them isn't a finite number,
 * compute_kri_status's comparisons all involve NaN and evaluate false,
 * silently falling through to 'WARNING' -- a real status value,
 * indistinguishable in the rendered PDF from a genuinely-computed WARNING.
 * Falls through to the explicit 'UNKNOWN' sentinel instead (its own badge
 * style in report_pdf.ts, distinct from OK/WARNING/ALERT) so a malformed AI
 * response is visibly flagged rather than silently misreported as a real
 * status.
 */
const annotateKriStatus = (content: ReportContent): ReportContent => {
  for (const kri of content.kri_dashboard ?? []) {
    const hasValidNumbers =
      Number.isFinite(kri.current_value) &&
      Number.isFinite(kri.alert_threshold) &&
      Number.isFinite(kri.target_value);
    kri.status = hasValidNumbers
      ? compute_kri_status(kri.current_value, kri.alert_threshold, kri.target_value)
      : 'UNKNOWN';
  }
  return content;
};

// Writes the rendered PDF buffer to a temp file so it can go through the same
// proven uploadCloud path every other upload in this codebase uses (uploadCloud
// reads from disk and unlinks the temp file itself, on success and on error).
const uploadReportPdf = async (pdf: Buffer): Promise<string> => {
  const uploadsDir = path.join(process.cwd(), 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const filePath = path.join(uploadsDir, `report-${crypto.randomUUID()}.pdf`);
  fs.writeFileSync(filePath, pdf);
  const result = await uploadCloud({
    fieldname: 'file',
    originalname: 'report.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    destination: uploadsDir,
    filename: path.basename(filePath),
    path: filePath,
    size: pdf.length,
  });
  return result.secure_url;
};

// Opportunistic reaper (#221). Marks any of this org's GENERATING rows whose
// updatedAt is older than STALE_GENERATING_MS as FAILED before the list is
// returned, so a row stranded by a crash (restart / OOM / catch-block update
// failing) resolves to a terminal state a user can recover from instead of
// spinning forever. Scoped to the caller's org and driven off the existing list
// read — no new queue/cron infra. Best-effort: a failure here must never break
// the list read, so it's logged and swallowed.
const sweepStaleGenerating = async (organizationId: string): Promise<void> => {
  const cutoff = new Date(Date.now() - STALE_GENERATING_MS);
  try {
    await prisma.report.updateMany({
      where: {
        org_account_id: organizationId,
        status: 'GENERATING' as never,
        updatedAt: { lt: cutoff },
      },
      data: {
        status: 'FAILED' as never,
        error_message: 'Generation timed out. Please try again.',
      },
    });
  } catch (error) {
    logger.error({ err: error, organizationId }, 'Stale GENERATING sweep failed');
  }
};

const get_all_report_from_db = async (req: Request) => {
  const { searchTerm, page, limit } = req.query;
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);

  // Sweep stale GENERATING rows to FAILED before reading, so the list the
  // client gets back already reflects the reaped state in the same round-trip.
  await sweepStaleGenerating(ctx.organizationId);

  const pagination = paginationHelper({ page: page as string, limit: limit as string });
  const { skip, limit: limitNumber } = pagination;

  const whereCondition: Prisma.ReportWhereInput = {
    org_account_id: ctx.organizationId,
    ...(searchTerm && {
      OR: [
        { title: { contains: searchTerm as string, mode: 'insensitive' } },
        { reference: { contains: searchTerm as string, mode: 'insensitive' } },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    prisma.report.findMany({
      where: whereCondition,
      skip,
      take: limitNumber,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.report.count({ where: whereCondition }),
  ]);

  return { data, meta: buildPaginationMeta(pagination, total) };
};

const get_single_report_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const id = req.params?.id as string;
  const result = await prisma.report.findUnique({
    where: { id, org_account_id: ctx.organizationId },
  });
  // Org filter is part of the query, so a cross-org id and a missing id both
  // 404 identically — same no-existence-oracle shape as every sibling module.
  if (!result) throw new AppError('Report not found', 404);
  return result;
};

/**
 * Synchronous generation pipeline. Creates the Report row up front at
 * GENERATING, then runs fetch -> AI -> render -> upload. On any pipeline
 * failure the row is transitioned to FAILED with an error_message and returned
 * (never left stuck at GENERATING), so the UI always reflects a terminal state.
 */
const generate_report_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);

  const requestedType = (req.body?.type as string) || SUPPORTED_TYPE;
  if (requestedType !== SUPPORTED_TYPE) {
    throw new AppError(`Report type '${requestedType}' is not supported yet`, 400);
  }

  // Per-org concurrency/dedupe guard (#219): each generate launches a ~300MB
  // headless Chromium; letting an org run several in parallel is a real OOM
  // risk on the container. Refuse a new generate while this org already has one
  // in flight. The staleness sweep (#221) reaps a crashed GENERATING row, so a
  // dead one never blocks the org permanently.
  const inFlight = await prisma.report.findFirst({
    where: { org_account_id: ctx.organizationId, status: 'GENERATING' as never },
    select: { id: true },
  });
  if (inFlight) {
    throw new AppError('A report is already being generated for this organization', 409);
  }

  const report = await prisma.report.create({
    data: {
      org_account_id: ctx.organizationId,
      type: SUPPORTED_TYPE as never,
      title: (req.body?.title as string) || 'Board Risk Report',
      status: 'GENERATING' as never,
      generated_by: user.accountId,
      ai_generated: true,
    },
  });

  try {
    const { input, approvalByRef } = await fetchOrgData(ctx);
    const content = annotateKriStatus(
      annotateApprovalStatus(await callReportContentAi(input, ctx.organizationId), approvalByRef),
    );
    const pdf = await renderReportPdf(content);
    const fileUrl = await uploadReportPdf(pdf);

    return await prisma.report.update({
      where: { id: report.id },
      data: {
        status: 'READY' as never,
        title: content.title || report.title,
        reference: content.reference || null,
        content: content as unknown as Prisma.InputJsonValue,
        file_url: fileUrl,
        parameters: {
          type: SUPPORTED_TYPE,
          risk_count: input.risks.length,
          kri_count: input.kris.length,
          site_count: input.sites.length,
          open_action_count: input.actions.length,
        } as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    // Never surface raw upstream/internal error text to the client, and never
    // leave the row at GENERATING. Log the real cause, persist a generic
    // failure reason on the row, and return the FAILED row so the UI shows a
    // recoverable terminal state (the user can just Generate again).
    logger.error({ err: error, reportId: report.id }, 'Report generation failed');
    const failed = await prisma.report.update({
      where: { id: report.id },
      data: {
        status: 'FAILED' as never,
        error_message: 'Report generation failed. Please try again.',
      },
    });
    return failed;
  }
};

const download_report_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const id = req.params?.id as string;
  const report = await prisma.report.findUnique({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!report) throw new AppError('Report not found', 404);
  // A report still generating (or one that failed) has no PDF to download.
  if (report.status === 'GENERATING' || !report.file_url) {
    throw new AppError('Report is not ready for download', 409);
  }
  // Mint a short-lived signed URL at request time rather than handing back the
  // permanent public object URL (#222). The stored file_url stays an internal
  // reference; the client only ever receives a URL that expires in
  // DOWNLOAD_URL_TTL_SECONDS, so a leaked link (referrer/history/screenshot)
  // stops working quickly and a "CONFIDENTIEL" report isn't world-readable
  // forever.
  const signedUrl = await getSignedDownloadUrl(report.file_url, DOWNLOAD_URL_TTL_SECONDS);
  return { file_url: signedUrl, expires_in: DOWNLOAD_URL_TTL_SECONDS };
};

const publish_report_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx: CallerOrgContext = await resolveCallerOrgContext(user.accountId);
  // Publishing is the human-review gate — org-admin-only, mirroring the
  // assertIsOrgAdmin gate used for other privileged org-wide actions.
  assertIsOrgAdmin(ctx);
  const id = req.params?.id as string;

  const report = await prisma.report.findUnique({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!report) throw new AppError('Report not found', 404);
  // Only READY -> PUBLISHED is a legal transition. Anything else (still
  // generating, failed, or already published) is a 409, not a silent no-op.
  if (report.status !== 'READY') {
    throw new AppError('Only a report in READY state can be published', 409);
  }

  return prisma.report.update({
    where: { id },
    data: {
      status: 'PUBLISHED' as never,
      reviewed_by: user.accountId,
      reviewed_at: new Date(),
    },
  });
};

export const report_service = {
  get_all_report_from_db,
  get_single_report_from_db,
  generate_report_into_db,
  download_report_from_db,
  publish_report_into_db,
};
