import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { assertCanWriteOrgResource, resolveCallerOrgContext } from '../../utils/org_scope.js';
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

const with_status = <
  T extends { current_value: number; alert_threshold: number; target_value: number },
>(
  kri: T,
): T & { status: KriStatus } => ({
  ...kri,
  status: compute_kri_status(kri.current_value, kri.alert_threshold, kri.target_value),
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

  const result = await prisma.kri.create({
    data: { ...payload, org_account_id: ctx.organizationId },
  });
  return with_status(result);
};

const update_kri_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
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

  const result = await prisma.kri.update({
    where: { id },
    data: { ...safeBody, org_account_id: ctx.organizationId },
  });
  return with_status(result);
};

/**
 * Records a new KRI reading and — if the reading crosses INTO ALERT status
 * from a non-ALERT status — creates an Alert row. Firing only on the
 * transition (not on every submission while already in ALERT) avoids
 * spamming duplicate alerts for a KRI that's submitted regularly while
 * still breached; this is the concretely-buildable "KRI threshold breach"
 * alert source (see FULLBLOOM-AUDIT.md) — the 60+-external-source ingestion
 * pipeline is explicitly out of scope for this ticket.
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
 * could both read the pre-update row, both independently decide
 * "previousStatus is not ALERT", and both insert an Alert for what is
 * really a single logical transition. With the guard, only the first write
 * wins; the loser's updateMany affects zero rows and gets a 409 asking it to
 * retry against the now-current value, instead of silently double-firing —
 * or silently losing the update, since a count of 0 is never treated as a
 * no-op success.
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

  const updateOutcome = await prisma.kri.updateMany({
    where: { id, updatedAt: existing.updatedAt },
    data: { current_value },
  });
  if (updateOutcome.count === 0) {
    throw new AppError('This KRI was updated by someone else — please retry.', 409);
  }
  // updateMany doesn't return the row (and doesn't refresh updatedAt locally),
  // so re-fetch for an accurate response rather than hand-rolling the merge.
  const result = await prisma.kri.findFirstOrThrow({ where: { id } });

  if (nextStatus === 'ALERT' && previousStatus !== 'ALERT') {
    await prisma.alert.create({
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
  }

  return with_status(result);
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
  delete_kri_from_db,
};
