import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import {
  assertCanReassignLineOfDefense,
  assertCanWriteOrgResource,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import {
  assertCanRecordLineReview,
  invalidateLiveLineReviews,
  LineOfDefenseValue,
  recordLineReview,
} from '../../utils/line_of_defense_review.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';

export type KriStatus = 'OK' | 'ALERT' | 'WARNING';

/**
 * Status = OK if val >= target, ALERT if val <= alert_threshold, WARNING
 * otherwise — the exact formula from the AEXA CDC spec (section 7.3). That
 * formula only reads correctly for "higher is better" KRIs (target above
 * threshold, e.g. a coverage %). Our actual KRIs are mostly the opposite —
 * "Supplier Lead Time" and "Cyber Incidents" are both "lower is better"
 * (target below threshold) — so the direction is inferred from whether
 * target is above or below alert_threshold, and the same three-way logic is
 * mirrored for that direction. Validation (kri.validation.ts) rejects
 * target_value === alert_threshold so direction is never ambiguous.
 */
export const compute_kri_status = (
  current_value: number,
  alert_threshold: number,
  target_value: number,
): KriStatus => {
  const higherIsBetter = target_value > alert_threshold;
  if (higherIsBetter) {
    if (current_value >= target_value) return 'OK';
    if (current_value <= alert_threshold) return 'ALERT';
    return 'WARNING';
  }
  if (current_value <= target_value) return 'OK';
  if (current_value >= alert_threshold) return 'ALERT';
  return 'WARNING';
};

// aexa-server#242: maps a KRI's declared monitoring cadence (kri.frequency)
// to the number of days after which a KRI that hasn't been re-measured is
// considered overdue. Matches the 4 fixed cadence options aexa-frontend's
// KRI form offers (src/i18n/locales/en.json's organization.kri.frequency
// keys). Lookup is case-insensitive; `frequency` itself stays a free string
// rather than being tightened to a real enum here, to avoid a breaking
// validation change for any existing row outside this set — an
// unrecognized or missing frequency means "no declared cadence to violate",
// so overdue is always false for it rather than erroring.
const FREQUENCY_INTERVAL_DAYS: Record<string, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 90,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A KRI is overdue when more time has elapsed since it was last measured
 * than its declared frequency allows. Computed at read time (like `status`)
 * rather than as a stored flag or a background-job-raised alert — no
 * scheduled-sweep infrastructure exists in this codebase yet, and adding one
 * just to raise an "overdue" Alert is a larger, separate change than this
 * ticket's scope (see #242's own framing: "needs a decision on ... whether
 * that should tie into the existing Alert system" — deferred as a fast-
 * follow once/if that infra exists).
 */
export const compute_kri_overdue = (
  frequency: string | null | undefined,
  last_measured_at: Date | null | undefined,
  now: Date = new Date(),
): boolean => {
  if (!frequency || !last_measured_at) return false;
  const intervalDays = FREQUENCY_INTERVAL_DAYS[frequency.trim().toLowerCase()];
  if (!intervalDays) return false;
  return now.getTime() - last_measured_at.getTime() > intervalDays * MS_PER_DAY;
};

const with_status = <
  T extends {
    current_value: number;
    alert_threshold: number;
    target_value: number;
    frequency: string | null;
    last_measured_at: Date | null;
  },
>(
  kri: T,
): T & { status: KriStatus; overdue: boolean } => ({
  ...kri,
  status: compute_kri_status(kri.current_value, kri.alert_threshold, kri.target_value),
  overdue: compute_kri_overdue(kri.frequency, kri.last_measured_at),
});

const get_all_kri_from_db = async (req: Request) => {
  const { risk_id, page, limit } = req.query as Record<string, string>;
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const pagination = paginationHelper({ page, limit });
  const { skip, limit: limitNumber } = pagination;

  const whereCondition: Record<string, unknown> = { org_account_id: ctx.organizationId };
  if (risk_id) whereCondition.risk_id = risk_id;

  const [data, total] = await Promise.all([
    prisma.kri.findMany({
      where: whereCondition,
      skip,
      take: limitNumber,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.kri.count({ where: whereCondition }),
  ]);

  return {
    meta: buildPaginationMeta(pagination, total),
    data: data.map(with_status),
  };
};

const get_single_kri_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as Record<string, string>;
  const result = await prisma.kri.findFirst({ where: { id, org_account_id: ctx.organizationId } });
  if (!result) throw new AppError('KRI not found', 404);
  return with_status(result);
};

const create_kri_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const payload = req.body;

  // A KRI must always be tied to a Risk (CDC spec — never standalone), and
  // that Risk must belong to the caller's own org, same cross-org check as
  // every other FK-into-another-module write in this codebase.
  const risk = await prisma.risk.findFirst({
    where: { id: payload.risk_id, org_account_id: ctx.organizationId },
  });
  if (!risk) throw new AppError('Risk not found', 404);
  // docs/design-docs/ai-risk-review-approval-workflow.md -- same guard as
  // risk_link.service.ts's assertRiskRefExists: linking to an explicitly-
  // dismissed risk is almost certainly a mistake. PENDING_REVIEW is still
  // allowed -- an unreviewed AI risk can be a legitimate KRI target while
  // awaiting review.
  if (risk.review_status === 'DISMISSED') {
    throw new AppError('This risk was dismissed and cannot be linked to a KRI.', 409);
  }

  // aexa-server#242: the value a KRI is created with counts as its first
  // reading — seeded via a nested create so the Kri row and its first
  // KriReading commit atomically (a single Prisma nested write runs in one
  // implicit transaction).
  const now = new Date();
  // Round-2 independent review of #328: the frontend never sends an
  // explicit owner: "" on create (a blank field is omitted entirely), but
  // owner has no .min(1) in create_kri's zod schema, so a direct API caller
  // posting owner: "" would otherwise store a literal empty string here —
  // the same "" vs NULL split update_kri_into_db already guards against.
  // Normalizing on both paths is what actually backs the "no owner is
  // always NULL" invariant, not just the update path.
  const result = await prisma.kri.create({
    data: {
      ...payload,
      owner: payload.owner === '' ? null : payload.owner,
      org_account_id: ctx.organizationId,
      last_measured_at: now,
      readings: {
        create: {
          org_account_id: ctx.organizationId,
          value: payload.current_value,
          recorded_at: now,
        },
      },
    },
  });
  return with_status(result);
};

const update_kri_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  // aexa-frontend#208: third-line independence — a LEAD_AUDITOR must not be
  // able to reclassify a first/second-line entity's ownership. Only checked
  // when line_of_defense is actually part of this update.
  if (req.body.line_of_defense !== undefined) {
    assertCanReassignLineOfDefense(ctx, 'MANAGEMENT_LINE');
  }
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.kri.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('KRI not found', 404);

  // Never trust org_account_id/risk_id supplied in the body on an update —
  // same reasoning as risk.service.ts's update_risk_into_db: risk_id in
  // particular must stay pinned to the Risk it was created against, an
  // update endpoint is not the place to re-parent a KRI to a different
  // (possibly cross-org) Risk.
  const { org_account_id: _org, risk_id: _risk, current_value: _cv, ...safeBody } = req.body;

  // create_kri's validation rejects target_value === alert_threshold, but a
  // PATCH can supply only one of the two fields — kri.validation.ts's refine
  // can't see the *other* field's existing DB value, so it only catches the
  // case where both are supplied together. Re-check against the merged
  // (existing + incoming) values here, where the existing row is available.
  const mergedTarget = safeBody.target_value ?? existing.target_value;
  const mergedThreshold = safeBody.alert_threshold ?? existing.alert_threshold;
  if (mergedTarget === mergedThreshold) {
    throw new AppError('target_value and alert_threshold must be different', 400);
  }

  // Independent review of #328: the frontend sends "" (not omitted) to
  // clear a previously-set owner, so a bare `...safeBody` spread would leave
  // an empty-string owner in the DB instead of NULL -- a real data-integrity
  // split from a KRI that simply never had an owner set (which stays NULL,
  // since create omits the key entirely rather than sending ""). Normalizing
  // here means "no owner" is always NULL regardless of which path cleared
  // it, so a future `WHERE owner IS NULL` query (an "unassigned KRIs"
  // filter, a report) sees every unowned KRI, not just some of them.
  const normalizedBody = safeBody.owner === '' ? { ...safeBody, owner: null } : safeBody;

  const result = await prisma.kri.update({
    where: { id },
    data: { ...normalizedBody, org_account_id: ctx.organizationId },
  });
  // #97: a review is a fact about the KRI's content AT the time it was
  // reviewed. An edit here makes every live review stale — see
  // line_of_defense_review.ts's invalidateLiveLineReviews and
  // risk.service.ts's update_risk_into_db for the identical pattern. This
  // update isn't wrapped in a $transaction (unlike Risk's), so this call
  // sits right after the plain prisma.kri.update commits, matching that
  // same placement.
  await invalidateLiveLineReviews(prisma.kriLineReview, 'kriId', id);
  return with_status(result);
};

/**
 * #97: records that `line` independently reviewed this KRI, superseding any
 * prior live review for that same line. Kept separate from
 * update_kri_into_db (assigning ownership) -- see line_of_defense_review.ts's
 * file comment for why ownership and review coverage are different facts,
 * not the same field. Mirrors risk.service.ts's record_risk_line_review.
 */
const record_kri_line_review = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.kri.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('KRI not found', 404);

  const { line, notes } = req.body as { line: LineOfDefenseValue; notes?: string };
  assertCanRecordLineReview(ctx, line);
  await recordLineReview(prisma.kriLineReview, 'kriId', id, user.accountId, line, notes);

  return prisma.kriLineReview.findMany({
    where: { kriId: id, invalidatedAt: null },
    orderBy: { line: 'asc' },
  });
};

/**
 * Records a new KRI reading — a permanent history entry (aexa-server#242),
 * not just an overwrite of current_value — and, on a status TRANSITION,
 * creates an Alert row. Firing only on the transition (not on every
 * submission while a status persists) avoids spamming duplicate alerts for
 * a KRI that's submitted regularly while still in the same state; this is
 * the concretely-buildable "KRI threshold breach" alert source (see
 * FULLBLOOM-AUDIT.md) — the 60+-external-source ingestion pipeline is
 * explicitly out of scope for this ticket.
 *
 * Three transition kinds are handled, each its own alert type/severity
 * (aexa-server#242 — real KRI methodology treats amber as a genuine
 * investigate-now signal, not a silent middle state, and a recovery is
 * worth a record too, not just silently dropping off the "needs attention"
 * list):
 *   - into ALERT (from non-ALERT): 'high' — unchanged from before this PR.
 *   - into WARNING (from non-WARNING, i.e. from OK or ALERT): 'medium'.
 *   - into OK (from non-OK, i.e. recovering from ALERT or WARNING): 'low',
 *     informational.
 *
 * The update is guarded by an optimistic-concurrency WHERE clause pinning
 * the row's `updatedAt` to the timestamp this request read it as, rather
 * than a plain `update`. `updatedAt` (not `current_value`) is the lock
 * column deliberately: `current_value` is the business value being written,
 * and two concurrent submissions that happen to write the *same* value (a
 * duplicate/repeated reading, or two clients both submitting "42") would
 * leave `current_value` unchanged across the race, so a guard keyed on it
 * would never see a mismatch and both writes — and both alert-creation
 * decisions — would sail through. `updatedAt` changes on every write
 * regardless of whether the value itself changed (Prisma's `@updatedAt`),
 * so it actually detects "someone else wrote this row since I read it."
 *
 * Without this guard, two near-simultaneous submissions for the same KRI
 * could both read the pre-update row, both independently decide the same
 * prior status, and both insert an Alert for what is really a single
 * logical transition. With the guard, only the first write wins; the
 * loser's updateMany affects zero rows and gets a 409 asking it to retry
 * against the now-current value, instead of silently double-firing — or
 * silently losing the update, since a count of 0 is never treated as a
 * no-op success.
 *
 * The KRI update, the KriReading insert, and any Alert creation all run in
 * one $transaction (same rationale as risk.service.ts's #203 precedent):
 * a crash between them must not leave a recorded value with no matching
 * history entry, or a fired alert for a write that didn't actually commit.
 */
const submit_kri_value_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as Record<string, string>;
  const { current_value } = req.body as { current_value: number };

  const existing = await prisma.kri.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('KRI not found', 404);

  const previousStatus = compute_kri_status(
    existing.current_value,
    existing.alert_threshold,
    existing.target_value,
  );
  const nextStatus = compute_kri_status(
    current_value,
    existing.alert_threshold,
    existing.target_value,
  );
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const updateOutcome = await tx.kri.updateMany({
      where: { id, updatedAt: existing.updatedAt },
      data: { current_value, last_measured_at: now },
    });
    if (updateOutcome.count === 0) {
      throw new AppError('This KRI was updated by someone else — please retry.', 409);
    }

    await tx.kriReading.create({
      data: {
        org_account_id: ctx.organizationId,
        kri_id: existing.id,
        value: current_value,
        recorded_at: now,
      },
    });

    if (nextStatus === 'ALERT' && previousStatus !== 'ALERT') {
      await tx.alert.create({
        data: {
          org_account_id: ctx.organizationId,
          kri_id: existing.id,
          source: 'KRI',
          type: 'kri_threshold_breach',
          severity: 'high',
          title: `${existing.name} breached its alert threshold`,
          description: `${existing.name} is now ${current_value} ${existing.unit} (alert threshold: ${existing.alert_threshold} ${existing.unit}).`,
          ai_generated: false,
        },
      });
    } else if (nextStatus === 'WARNING' && previousStatus !== 'WARNING') {
      await tx.alert.create({
        data: {
          org_account_id: ctx.organizationId,
          kri_id: existing.id,
          source: 'KRI',
          type: 'kri_warning_threshold',
          severity: 'medium',
          title: `${existing.name} is approaching its alert threshold`,
          description: `${existing.name} is now ${current_value} ${existing.unit} (target: ${existing.target_value} ${existing.unit}, alert threshold: ${existing.alert_threshold} ${existing.unit}).`,
          ai_generated: false,
        },
      });
    } else if (nextStatus === 'OK' && previousStatus !== 'OK') {
      await tx.alert.create({
        data: {
          org_account_id: ctx.organizationId,
          kri_id: existing.id,
          source: 'KRI',
          type: 'kri_recovered',
          severity: 'low',
          title: `${existing.name} has recovered to OK`,
          description: `${existing.name} is now ${current_value} ${existing.unit}, back within target range.`,
          ai_generated: false,
        },
      });
    }

    // updateMany doesn't return the row (and doesn't refresh updatedAt
    // locally), so re-fetch inside the same transaction for a consistent
    // read rather than hand-rolling the merge.
    return tx.kri.findFirstOrThrow({ where: { id } });
  });

  return with_status(result);
};

const get_kri_readings_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as Record<string, string>;
  const { page, limit } = req.query as Record<string, string>;

  const kri = await prisma.kri.findFirst({ where: { id, org_account_id: ctx.organizationId } });
  if (!kri) throw new AppError('KRI not found', 404);

  const pagination = paginationHelper({ page, limit });
  const { skip, limit: limitNumber } = pagination;

  const [data, total] = await Promise.all([
    prisma.kriReading.findMany({
      where: { kri_id: id },
      skip,
      take: limitNumber,
      orderBy: { recorded_at: 'desc' },
    }),
    prisma.kriReading.count({ where: { kri_id: id } }),
  ]);

  return {
    meta: buildPaginationMeta(pagination, total),
    data,
  };
};

const delete_kri_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.kri.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('KRI not found', 404);
  const result = await prisma.kri.delete({ where: { id } });
  return result;
};

export const kri_service = {
  get_all_kri_from_db,
  get_single_kri_from_db,
  create_kri_into_db,
  update_kri_into_db,
  submit_kri_value_into_db,
  get_kri_readings_from_db,
  delete_kri_from_db,
  record_kri_line_review,
};
