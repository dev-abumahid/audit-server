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
  assertCanWriteOrgResource,
  assertIsOrgAdmin,
  resolveCallerOrgContext,
  type CallerOrgContext,
} from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';
import uploadCloud, { getSignedDownloadUrl } from '../../utils/cloudinary.js';
import { renderReportPdf, type ReportContent } from '../../utils/report_pdf.js';
import { AI_INTERNAL_SECRET_HEADER } from '../ai/ai.service.js';

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

// Statuses that mean "this action is not yet done" — used to count/select the
// open actions a board report cares about.
const OPEN_ACTION_STATUSES = ['TO_DO', 'IN_PROGRESS'];

const fetchOrgData = async (orgAccountId: string): Promise<PipelineInput> => {
  const [profile, risks, kris, sites, actions] = await Promise.all([
    prisma.organizationProfile.findUnique({ where: { accountId: orgAccountId } }),
    prisma.risk.findMany({
      where: { org_account_id: orgAccountId },
      include: { site: { select: { name: true } } },
      orderBy: { residual_score: 'desc' },
    }),
    prisma.kri.findMany({
      where: { org_account_id: orgAccountId },
      include: { risk: { select: { name: true } } },
    }),
    prisma.site.findMany({ where: { org_account_id: orgAccountId } }),
    prisma.action.findMany({
      where: { orgAccountId, status: { in: OPEN_ACTION_STATUSES as never } },
      include: { site: { select: { name: true } } },
    }),
  ]);

  return {
    organization: {
      name: profile?.organizationName || 'Organization',
      description: profile?.organizationDescription ?? null,
      location: profile?.organizationLocation ?? null,
      website: profile?.organizationWebsite ?? null,
    },
    risks: risks.map((r) => ({
      ref: r.id.slice(0, 8),
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
    })),
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
        ...AI_INTERNAL_SECRET_HEADER,
        // aexa-ai's /report_content is @limiter.limit(expensive) and its
        // get_org_key (app/limiter.py) keys that budget on the X-Organization
        // header, falling back to remote IP. Without this header every org fell
        // through to aexa-server's single shared IP, so one org's heavy use
        // starved every other org's report generation. Send the caller's org id
        // so the per-org bucket actually applies (#219).
        'X-Organization': organizationId,
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
    const input = await fetchOrgData(ctx.organizationId);
    const content = await callReportContentAi(input, ctx.organizationId);
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
