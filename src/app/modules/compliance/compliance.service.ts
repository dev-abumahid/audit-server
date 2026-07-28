import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import uploadCloud from '../../utils/cloudinary.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import {
  assertCanReassignLineOfDefense,
  assertCanWriteOrgResource,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';

// aexa-server#243: due dates previously had zero teeth — an obligation 18
// months past due_date with no attachments stayed "compliant" in the
// scorecard forever, with no derived flag anywhere. Computed at read time
// (same pattern as kri.service.ts's compute_kri_overdue), not a stored
// column or an auto-degraded status: overdue is a passive signal a caller
// can act on, not a silent rewrite of a user-set status. Deliberately does
// NOT auto-force status out of 'compliant' — a bigger, more surprising
// behavior change than this ticket's "which decision" framing asked to
// settle outright, and the real fix for "a compliant obligation silently
// goes stale" is the recurrence/re-attestation model (deferred — see the
// file-level PR description) rather than a blunt auto-flip here. Also NOT
// wired into a new Alert/BullMQ job: no scheduled-sweep infrastructure
// exists in this codebase yet (same reasoning as kri.service.ts's overdue).
//
// 'not_applicable' is excluded, mirroring the scorecard's own N/A exclusion
// (aexa-server#239/#240) — an obligation that doesn't apply to this org was
// never going to be met by its due_date, so it isn't a real compliance gap.
// Every other status (including 'compliant') is eligible: a "compliant"
// obligation still sitting past its due_date with no re-attestation is
// exactly the stale-data gap this ticket describes.
//
// aexa-server#250: for a recurring obligation, `next_review_date` (not the
// original one-time `due_date`) is the date that actually matters for
// staleness — a recurring obligation whose first due_date has long since
// passed but which has been re-attested on schedule should NOT read as
// overdue forever; conversely one that's fallen behind its cadence should.
// Falls back to due_date when next_review_date is unset (a non-recurring
// obligation, or a recurring one that hasn't had its first cycle seeded
// yet), preserving #243's original behavior exactly for that case.
export const compute_obligation_overdue = (
  due_date: Date | null | undefined,
  status: string,
  now: Date = new Date(),
  next_review_date?: Date | null,
): boolean => {
  const effectiveDate = next_review_date ?? due_date;
  if (!effectiveDate) return false;
  if (status === 'not_applicable') return false;
  return effectiveDate.getTime() < now.getTime();
};

const with_overdue = <
  T extends { due_date: Date | null; status: string; next_review_date?: Date | null },
>(
  obligation: T,
): T & { overdue: boolean } => ({
  ...obligation,
  overdue: compute_obligation_overdue(
    obligation.due_date,
    obligation.status,
    new Date(),
    obligation.next_review_date,
  ),
});

// aexa-server#250: maps a declared recurrence cadence to the number of days
// until the next review is due, mirroring kri.service.ts's
// FREQUENCY_INTERVAL_DAYS (case-insensitive lookup, free string rather than
// a DB enum). 'one_time'/null/unrecognized means no recurrence — no interval
// to compute a next_review_date from.
const RECURRENCE_INTERVAL_DAYS: Record<string, number> = {
  monthly: 30,
  quarterly: 90,
  annual: 365,
};

const computeNextReviewDate = (recurrence: string | null | undefined, from: Date): Date | null => {
  if (!recurrence) return null;
  const intervalDays = RECURRENCE_INTERVAL_DAYS[recurrence.trim().toLowerCase()];
  if (!intervalDays) return null;
  return new Date(from.getTime() + intervalDays * 24 * 60 * 60 * 1000);
};

// aexa-server#243: evidence was decorative — attachments were validated as
// HTTPS URLs but never inspected by any business logic, so nothing required
// evidence to claim "compliant". This is the concretely-buildable hard gate
// the ticket posed as an option (vs. staying a soft/UI-only recommendation):
// a GRC product whose value proposition includes audit-readiness can't let
// an unbacked "compliant" claim through. Applies to the EFFECTIVE
// (merged-with-existing, for an update) status/attachments — not just
// whichever of the two fields the request happens to touch — so an edit
// that leaves status: 'compliant' with zero attachments in place (e.g. a
// pre-existing grandfathered row, or a request that clears attachments
// without also downgrading status) is blocked too, not just a create/update
// that explicitly sets both at once.
const assertCompliantHasEvidence = (status: string, attachments: string[] | undefined): void => {
  if (status !== 'compliant') return;
  if (!attachments || attachments.length === 0) {
    throw new AppError('A compliant obligation requires at least one evidence attachment.', 400);
  }
};

const get_all_compliance_from_db = async (req: Request) => {
  const { searchTerm, status, domain, page, limit } = req.query;
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);

  const pagination = paginationHelper({ page: page as string, limit: limit as string });
  const { skip, limit: limitNumber } = pagination;

  const whereCondition: Prisma.ComplianceObligationWhereInput = {
    org_account_id: ctx.organizationId,
    ...(status && { status: status as string }),
    ...(domain && { domain: domain as string }),
    ...(searchTerm && {
      OR: [
        {
          title: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
        {
          description: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
        {
          owner: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    prisma.complianceObligation.findMany({
      where: whereCondition,
      skip,
      take: limitNumber,
      orderBy: {
        createdAt: 'desc',
      },
    }),
    prisma.complianceObligation.count({
      where: whereCondition,
    }),
  ]);

  return {
    data: data.map(with_overdue),
    meta: buildPaginationMeta(pagination, total),
  };
};

const get_single_compliance_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const id = req.params?.id as string;
  const result = await prisma.complianceObligation.findUnique({
    where: { id, org_account_id: ctx.organizationId },
  });
  // Every sibling module's get_single_* throws 404 for a missing/cross-org
  // record rather than returning a bare 200 with data: null.
  if (!result) throw new AppError('Compliance obligation not found', 404);
  return with_overdue(result);
};

/**
 * A supplied site_id must belong to the caller's own org. Without this check a
 * caller could link an obligation to another org's Site UUID (which the raw FK
 * happily accepts), and the scorecard's `site: { name }` join would then leak
 * that foreign org's site name back to the caller — a cross-tenant read.
 * A null/undefined/empty site_id means "org-wide" and needs no check. Mirrors
 * the `prisma.site.findFirst` + "Site not found" 404 pattern inspection.service.ts
 * uses when it validates a foreign-scoped Site reference. See aexa-server#205.
 */
const assertSiteBelongsToOrg = async (site_id: unknown, orgAccountId: string): Promise<void> => {
  if (typeof site_id !== 'string' || site_id === '') return;
  const site = await prisma.site.findFirst({
    where: { id: site_id, org_account_id: orgAccountId },
    select: { id: true },
  });
  if (!site) throw new AppError('Site not found', 404);
};

const create_compliance_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  // aexa-server#250: next_review_date is derived, never client-settable —
  // discard whatever's supplied and seed it ourselves below.
  const { next_review_date: _ignoredReviewDate, ...payload } = req.body;
  await assertSiteBelongsToOrg(payload.site_id, ctx.organizationId);
  assertCompliantHasEvidence(payload.status, payload.attachments);
  payload.org_account_id = ctx.organizationId;
  // aexa-server#250: the first cycle's due date doubles as the first review
  // date when a recurrence is declared — there's no prior attestation yet
  // to compute one from. Falls back to now + the cadence's interval when no
  // due_date is supplied at all: without this, a recurring obligation
  // created without a due_date would seed next_review_date: null and read
  // as permanently non-overdue until its first attestation, defeating the
  // whole "continuous oversight" point for exactly the obligations that
  // didn't have a due_date to fall back on. Non-recurring obligations get
  // no review date either way.
  payload.next_review_date = payload.recurrence
    ? (payload.due_date ?? computeNextReviewDate(payload.recurrence, new Date()))
    : null;
  const result = await prisma.complianceObligation.create({ data: payload });
  return with_overdue(result);
};

const update_compliance_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  // aexa-frontend#208: third-line independence — a LEAD_AUDITOR must not be
  // able to reclassify a first/second-line entity's ownership. Only checked
  // when line_of_defense is actually part of this update.
  if (req.body.line_of_defense !== undefined) {
    assertCanReassignLineOfDefense(ctx, 'MANAGEMENT_LINE');
  }
  const id = req.params.id as string;
  const existing = await prisma.complianceObligation.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Compliance obligation not found', 404);
  // A re-scoping update must still point at one of the caller's own sites (an
  // explicit null clears the scope and is fine). See aexa-server#205.
  await assertSiteBelongsToOrg(req.body.site_id, ctx.organizationId);
  // Never trust org_account_id from the request body on an update — an
  // authorized (ADMIN/LEAD_AUDITOR) caller could otherwise reassign an
  // obligation to a different org's anchor account id, a cross-tenant
  // integrity issue even though ownership of the *existing* row was verified
  // above. Same guard audit.service.ts / site.service.ts apply.
  // aexa-server#250: next_review_date is derived, never client-settable via
  // a direct PATCH — it only ever changes through attest_compliance_into_db
  // below (or implicitly, when create seeds it).
  const { org_account_id: _ignored, next_review_date: _ignoredReviewDate, ...safeBody } = req.body;
  // aexa-server#243: check the EFFECTIVE (merged) status/attachments, not
  // just whichever of the two fields this particular PATCH happens to
  // include — see assertCompliantHasEvidence's own comment for why.
  assertCompliantHasEvidence(
    safeBody.status ?? existing.status,
    safeBody.attachments ?? existing.attachments,
  );
  const data: Prisma.ComplianceObligationUncheckedUpdateInput = {
    ...safeBody,
    org_account_id: ctx.organizationId,
  };
  // aexa-server#260: recurrence is being cleared to falsy/'one_time'/an
  // unrecognized cadence in THIS patch -- next_review_date must clear with
  // it, or compute_obligation_overdue (which reads next_review_date ??
  // due_date) keeps comparing against a stale future date seeded by the old
  // cadence, falsely flipping the obligation overdue once that date passes
  // even though there's no more cadence to have missed. Only fires when
  // recurrence is actually part of this PATCH -- an update that doesn't
  // touch recurrence at all must leave next_review_date exactly as it was.
  if (
    req.body.recurrence !== undefined &&
    computeNextReviewDate(req.body.recurrence, new Date()) === null
  ) {
    data.next_review_date = null;
  }
  const result = await prisma.complianceObligation.update({
    where: { id },
    data,
  });
  return with_overdue(result);
};

/**
 * aexa-server#250: records a permanent re-attestation entry ("this
 * obligation was reconfirmed on this date, by this person, with this
 * status") and, if the obligation has a declared recurrence, advances
 * next_review_date to attested_at + the cadence's interval — so a
 * recurring obligation that's actually being kept current on schedule
 * stops reading as overdue, without anyone touching due_date or status
 * directly. A non-recurring obligation can still be attested (the history
 * entry itself is a legitimate audit-trail fact — "someone re-checked
 * this" — independent of whether there's a cadence to advance), it just
 * leaves next_review_date untouched (null stays null).
 *
 * Deliberately NOT a maker-checker approve/reject cycle — see
 * ComplianceAttestation's own schema comment for why that's out of scope
 * here (reserved for #252). The obligation write and the attestation
 * insert run in one $transaction so a crash between them can't leave a
 * recorded re-attestation with no corresponding next_review_date update
 * (or vice versa).
 */
const attest_compliance_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const id = req.params.id as string;
  const existing = await prisma.complianceObligation.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Compliance obligation not found', 404);

  const { note } = req.body as { note?: string };
  const attestedAt = new Date();

  // aexa-server#250: re-read the row's recurrence/status INSIDE the
  // transaction, immediately before computing what to write, rather than
  // reusing `existing` (fetched before the transaction even opened) — same
  // TOCTOU fix as #241's residual-score resolution and #242's KRI
  // submission. Without this, a concurrent update_compliance_into_db that
  // changes `recurrence` (or `status`) between the check above and this
  // transaction could have its change silently clobbered by a
  // next_review_date computed from a stale cadence, or an attestation
  // snapshotting a status that was never actually live.
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.complianceObligation.findFirst({ where: { id } });
    if (!current) throw new AppError('Compliance obligation not found', 404);
    const nextReviewDate = computeNextReviewDate(current.recurrence, attestedAt);

    const attestation = await tx.complianceAttestation.create({
      data: {
        org_account_id: ctx.organizationId,
        obligation_id: id,
        attested_by: user.accountId,
        attested_at: attestedAt,
        status_at_attestation: current.status,
        note,
      },
    });
    const obligation = await tx.complianceObligation.update({
      where: { id },
      data: { next_review_date: nextReviewDate },
    });
    return { attestation, obligation };
  });

  return { attestation: result.attestation, obligation: with_overdue(result.obligation) };
};

const get_compliance_attestations_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const id = req.params.id as string;
  const { page, limit } = req.query as Record<string, string>;

  const obligation = await prisma.complianceObligation.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!obligation) throw new AppError('Compliance obligation not found', 404);

  const pagination = paginationHelper({ page, limit });
  const { skip, limit: limitNumber } = pagination;

  const [data, total] = await Promise.all([
    prisma.complianceAttestation.findMany({
      where: { obligation_id: id },
      skip,
      take: limitNumber,
      orderBy: { attested_at: 'desc' },
    }),
    prisma.complianceAttestation.count({ where: { obligation_id: id } }),
  ]);

  return {
    data,
    meta: buildPaginationMeta(pagination, total),
  };
};

const delete_compliance_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const id = req.params.id as string;
  // Existence check before delete, matching every sibling module — deleting a
  // missing/cross-org id would otherwise fall through to Prisma's raw P2025
  // (a 500) instead of the clean 404 the rest of the API returns.
  const existing = await prisma.complianceObligation.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Compliance obligation not found', 404);
  const result = await prisma.complianceObligation.delete({
    where: { id, org_account_id: ctx.organizationId },
  });
  return result;
};

/**
 * Uploads a compliance-evidence attachment to Cloudinary and returns its URL.
 * Two-step flow identical to action.service.ts's upload_action_attachment: the
 * frontend uploads the file here first, then includes the returned URL in the
 * `attachments` array on a subsequent create/update call — so this endpoint
 * itself doesn't touch any ComplianceObligation row. Response shape ({ url })
 * matches the action endpoint the frontend upload helper already expects.
 *
 * It still needs the same write-role gate as create/update: a VIEWER /
 * LIGHT_USER can't attach a file to any obligation, so letting them push files
 * into Cloudinary here is pure resource abuse / orphaned uploads. Resolve the
 * caller's org context and assertCanWriteOrgResource before touching storage.
 * See aexa-server#207.
 */
const upload_compliance_attachment_into_aws = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const file = req.file;
  if (!file) {
    throw new AppError('File is required', 400);
  }
  const result = await uploadCloud(file);
  return { url: result.secure_url };
};

// Scorecard banding per CDC spec 7.7. Boundaries are inclusive on the lower
// edge (`>=`), so the exact wording that matches the code is:
//   green:  ratio >= 0.85   (85% and above)
//   orange: 0.70 <= ratio < 0.85
//   red:    ratio < 0.70
// A cell/group with no applicable obligations (total 0) has no meaningful
// ratio — return 'none' so the frontend renders it as an empty/neutral cell
// rather than a misleading red 0%.
type ScoreBand = 'green' | 'orange' | 'red' | 'none';

const bandFor = (compliant: number, total: number): ScoreBand => {
  if (total === 0) return 'none';
  const ratio = compliant / total;
  if (ratio >= 0.85) return 'green';
  if (ratio >= 0.7) return 'orange';
  return 'red';
};

const scoreCell = (compliant: number, total: number) => ({
  compliant,
  total,
  ratio: total === 0 ? 0 : compliant / total,
  band: bandFor(compliant, total),
});

/**
 * Computed compliance scorecard, org-scoped. Returns an overall compliant/total
 * ratio plus breakdowns by domain and by site, and a site×domain matrix for the
 * red/orange/green grid the frontend renders. Compliant is defined as
 * status === 'compliant'. Computed from real rows at request time — no caching
 * needed at this scale (Phase 1).
 *
 * Methodology audit finding: 'not_applicable' obligations must be excluded
 * from every ratio's denominator (and numerator, trivially — they're never
 * 'compliant'), the same convention real compliance-management tooling uses
 * (e.g. ServiceNow GRC). An obligation genuinely not applicable to an org
 * isn't a compliance gap, so counting it against the org's score
 * systematically understates real compliance — 7/10 compliant with 3 N/A
 * used to score 70% (orange), when the real figure is 100% (green, 7/7
 * scorable). statusCounts (the raw per-status tally the summary cards read)
 * still covers every obligation including N/A, so the N/A count itself
 * stays visible — only the ratio math excludes them.
 */
const get_compliance_scorecard_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);

  const obligations = await prisma.complianceObligation.findMany({
    where: { org_account_id: ctx.organizationId },
    select: {
      status: true,
      domain: true,
      site_id: true,
      site: { select: { name: true } },
      due_date: true,
      next_review_date: true,
    },
  });

  const isCompliant = (status: string) => status === 'compliant';
  const isNotApplicable = (status: string) => status === 'not_applicable';
  const scorableObligations = obligations.filter((o) => !isNotApplicable(o.status));

  // Overall
  const overallTotal = scorableObligations.length;
  const overallCompliant = scorableObligations.filter((o) => isCompliant(o.status)).length;
  const excludedNotApplicable = obligations.length - scorableObligations.length;
  // aexa-server#243: whole-org overdue count, same rationale as
  // statusCounts below (must stay correct once the obligation list is
  // server-side paginated, can't be derived from a single page of rows).
  const overdueCount = obligations.filter((o) =>
    compute_obligation_overdue(o.due_date, o.status, new Date(), o.next_review_date),
  ).length;

  // Org-wide tally per status. The frontend summary cards (compliant /
  // non-compliant counts) need whole-org totals that stay correct once the
  // obligation LIST is server-side paginated — they can no longer be derived
  // from a single page of rows. See aexa-frontend#161. Covers every
  // obligation including not_applicable ones (unlike the ratio math above)
  // so the N/A count itself is still visible to the caller.
  const statusCounts: Record<string, number> = {};
  for (const o of obligations) {
    statusCounts[o.status] = (statusCounts[o.status] ?? 0) + 1;
  }

  // By domain
  const domainMap = new Map<string, { compliant: number; total: number }>();
  // By site (null site_id === org-wide)
  const siteMap = new Map<
    string,
    { site_id: string | null; site_name: string | null; compliant: number; total: number }
  >();
  // Site × domain matrix
  const matrixMap = new Map<
    string,
    {
      site_id: string | null;
      site_name: string | null;
      domain: string;
      compliant: number;
      total: number;
    }
  >();

  for (const o of scorableObligations) {
    const compliant = isCompliant(o.status) ? 1 : 0;
    const siteKey = o.site_id ?? '__org_wide__';
    const siteName = o.site?.name ?? null;

    const d = domainMap.get(o.domain) ?? { compliant: 0, total: 0 };
    d.compliant += compliant;
    d.total += 1;
    domainMap.set(o.domain, d);

    const s = siteMap.get(siteKey) ?? {
      site_id: o.site_id ?? null,
      site_name: siteName,
      compliant: 0,
      total: 0,
    };
    s.compliant += compliant;
    s.total += 1;
    siteMap.set(siteKey, s);

    const mKey = `${siteKey}::${o.domain}`;
    const m = matrixMap.get(mKey) ?? {
      site_id: o.site_id ?? null,
      site_name: siteName,
      domain: o.domain,
      compliant: 0,
      total: 0,
    };
    m.compliant += compliant;
    m.total += 1;
    matrixMap.set(mKey, m);
  }

  return {
    overall: scoreCell(overallCompliant, overallTotal),
    excludedNotApplicable,
    overdueCount,
    statusCounts,
    byDomain: Array.from(domainMap.entries())
      .map(([domain, v]) => ({ domain, ...scoreCell(v.compliant, v.total) }))
      .sort((a, b) => a.domain.localeCompare(b.domain)),
    bySite: Array.from(siteMap.values())
      .map((v) => ({
        site_id: v.site_id,
        site_name: v.site_name,
        ...scoreCell(v.compliant, v.total),
      }))
      .sort((a, b) => (a.site_name ?? '').localeCompare(b.site_name ?? '')),
    matrix: Array.from(matrixMap.values()).map((v) => ({
      site_id: v.site_id,
      site_name: v.site_name,
      domain: v.domain,
      ...scoreCell(v.compliant, v.total),
    })),
  };
};

export const compliance_service = {
  get_all_compliance_from_db,
  get_single_compliance_from_db,
  create_compliance_into_db,
  update_compliance_into_db,
  delete_compliance_from_db,
  upload_compliance_attachment_into_aws,
  get_compliance_scorecard_from_db,
  attest_compliance_into_db,
  get_compliance_attestations_from_db,
};
