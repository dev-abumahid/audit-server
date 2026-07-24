import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import {
  assertCanWriteOrgResource,
  assertIsOrgAdmin,
  CallerOrgContext,
  recordOrgAuditEvent,
  requireCallerOrganizationId,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';

/**
 * Risk maker-checker approval workflow (aexa-frontend#95).
 *
 * Structural twin of FindingAssignment's approve/reject flow
 * (action.service.ts): a LEAD_AUDITOR/ADMIN submits a risk's current
 * assessment for approval, an ADMIN approves or rejects it, and every state
 * transition writes an OrgAuditLog row. `invalidatedAt` plays the exact role
 * FindingAssignment.revokedAt does — a soft-supersede that both forces
 * resubmission after an edit and guards the approve/reject path against
 * actioning a cycle that was superseded while still pending.
 *
 * A "live" cycle is one that still represents the current, un-decided-or-active
 * approval state: `invalidatedAt IS NULL AND status != 'REJECTED'`. The partial
 * unique index in the migration guarantees at most one live cycle per risk, so
 * a rejected or invalidated cycle never blocks a fresh submission.
 */

/**
 * Resolves a Risk scoped to the caller's org anchor, or 404s. Mirrors
 * risk.service.ts's own ownership check (org_account_id === ctx.organizationId).
 */
const requireOrgScopedRisk = async (riskId: string, ctx: CallerOrgContext) => {
  const risk = await prisma.risk.findFirst({
    where: { id: riskId, org_account_id: ctx.organizationId },
  });
  if (!risk) throw new AppError('Risk not found', 404);
  return risk;
};

/**
 * Resolves a RiskApproval scoped to the caller's org — RiskApproval has no
 * org_account_id column, so this joins through its parent Risk to check it,
 * exactly like requireOrgScopedFindingAssignment joins through Action.
 */
const requireOrgScopedApproval = async (approvalId: string, ctx: CallerOrgContext) => {
  const approval = await prisma.riskApproval.findFirst({
    where: { id: approvalId, risk: { org_account_id: ctx.organizationId } },
  });
  if (!approval) throw new AppError('Risk approval not found', 404);
  return approval;
};

/**
 * Derives the display-facing approval state for a risk from its most recent
 * approval cycle. An invalidated latest cycle reads as NOT_SUBMITTED because
 * the reviewed version is stale and a fresh submission is required.
 */
export type RiskApprovalDisplayState =
  | 'NOT_SUBMITTED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED';

export const deriveApprovalState = (
  latest: { status: string; invalidatedAt: Date | null } | null,
): RiskApprovalDisplayState => {
  if (!latest) return 'NOT_SUBMITTED';
  if (latest.invalidatedAt !== null) return 'NOT_SUBMITTED';
  return latest.status as 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
};

/**
 * LEAD_AUDITOR/ADMIN. Submits a risk's current assessment for approval,
 * creating a PENDING_APPROVAL cycle. Blocks if a live (pending or approved,
 * non-invalidated) cycle already exists — the same "one live row" invariant
 * FindingAssignment enforces, surfaced here as an explicit 409 rather than an
 * idempotent return since the submitter needs to know their risk is already in
 * the queue (or already approved) rather than silently getting the old row.
 */
const submit_risk_for_approval = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { id: riskId } = req.params as { id: string };

  await requireOrgScopedRisk(riskId, ctx);
  const organizationId = await requireCallerOrganizationId(ctx);

  const liveWhere: Prisma.RiskApprovalWhereInput = {
    riskId,
    invalidatedAt: null,
    status: { not: 'REJECTED' },
  };

  const existingLive = await prisma.riskApproval.findFirst({ where: liveWhere });
  if (existingLive) {
    if (existingLive.status === 'PENDING_APPROVAL') {
      throw new AppError('This risk already has a pending approval request.', 409);
    }
    throw new AppError('This risk is already approved. Edit it to require a fresh approval.', 409);
  }

  let approval;
  try {
    approval = await prisma.riskApproval.create({
      data: { riskId, submittedById: user.accountId, status: 'PENDING_APPROVAL' },
    });
  } catch (err) {
    // Same race as FindingAssignment/OrgInvitation: two concurrent submit
    // requests can both miss each other's row via findFirst; the partial
    // unique index rejects the loser. Resolve to the winner's row instead of
    // a raw 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.riskApproval.findFirst({ where: liveWhere });
      if (winner) return winner;
    }
    throw err;
  }

  await recordOrgAuditEvent({
    organizationId,
    action: 'RISK_SUBMITTED_FOR_APPROVAL',
    actorAccountId: user.accountId,
    metadata: { riskId, approvalId: approval.id },
  });

  return approval;
};

/**
 * ADMIN-only. Approves a PENDING_APPROVAL cycle, moving it to APPROVED.
 * Mirrors approve_finding_assignment exactly, including the
 * superseded-while-pending guard: a risk edited after submission sets
 * invalidatedAt on the pending cycle, and approving that stale cycle would
 * record RISK_APPROVAL_APPROVED for an assessment that no longer exists.
 */
const approve_risk = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertIsOrgAdmin(ctx);
  const { id } = req.params as { id: string };
  const organizationId = await requireCallerOrganizationId(ctx);

  const approval = await requireOrgScopedApproval(id, ctx);
  if (approval.status !== 'PENDING_APPROVAL') {
    throw new AppError('Only a pending approval can be approved.', 400);
  }
  if (approval.invalidatedAt !== null) {
    throw new AppError(
      'This risk was edited after submission and must be resubmitted for approval.',
      400,
    );
  }

  const updated = await prisma.riskApproval.update({
    where: { id },
    data: { status: 'APPROVED', decidedById: user.accountId, decidedAt: new Date() },
  });

  await recordOrgAuditEvent({
    organizationId,
    action: 'RISK_APPROVAL_APPROVED',
    actorAccountId: user.accountId,
    metadata: { riskId: approval.riskId, approvalId: approval.id },
  });

  return updated;
};

/**
 * ADMIN-only. Rejects a PENDING_APPROVAL cycle, moving it to REJECTED and
 * recording the reviewer's reason. Same superseded-while-pending guard as
 * approve_risk.
 */
const reject_risk = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertIsOrgAdmin(ctx);
  const { id } = req.params as { id: string };
  const { decisionNote } = req.body as { decisionNote: string };
  const organizationId = await requireCallerOrganizationId(ctx);

  const approval = await requireOrgScopedApproval(id, ctx);
  if (approval.status !== 'PENDING_APPROVAL') {
    throw new AppError('Only a pending approval can be rejected.', 400);
  }
  if (approval.invalidatedAt !== null) {
    throw new AppError(
      'This risk was edited after submission and must be resubmitted for approval.',
      400,
    );
  }

  const updated = await prisma.riskApproval.update({
    where: { id },
    data: {
      status: 'REJECTED',
      decidedById: user.accountId,
      decidedAt: new Date(),
      decisionNote,
    },
  });

  await recordOrgAuditEvent({
    organizationId,
    action: 'RISK_APPROVAL_REJECTED',
    actorAccountId: user.accountId,
    metadata: { riskId: approval.riskId, approvalId: approval.id, decisionNote },
  });

  return updated;
};

/**
 * Any active org member scoped to the risk may read its approval state (it
 * backs a per-risk badge). Returns the derived state plus the latest cycle
 * for detail rendering (who submitted/decided, decision note).
 */
const get_risk_approval_state = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id: riskId } = req.params as { id: string };

  await requireOrgScopedRisk(riskId, ctx);

  const latest = await prisma.riskApproval.findFirst({
    where: { riskId },
    orderBy: { createdAt: 'desc' },
  });

  return { riskId, status: deriveApprovalState(latest), approval: latest };
};

/**
 * Edit hook, called from update_risk_into_db. Invalidates any live
 * (PENDING_APPROVAL or APPROVED, non-invalidated) approval cycle for a risk
 * that's being edited: a changed assessment must be re-reviewed, so the prior
 * cycle no longer reflects reality and a fresh submission is required.
 *
 * A single updateMany keeps this a hook rather than a check scattered across
 * call sites. No-op (and no audit write) when there's no live cycle — the
 * common case for a risk that was never submitted, including every solo-admin
 * (no real Organization) edit, which is why organizationId is resolved lazily
 * only when there's actually something to invalidate.
 */
const invalidateLiveApprovalsOnEdit = async (
  riskId: string,
  ctx: CallerOrgContext,
  actorAccountId: string,
): Promise<void> => {
  const live = await prisma.riskApproval.findMany({
    where: {
      riskId,
      invalidatedAt: null,
      status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
    },
    select: { id: true },
  });
  if (live.length === 0) return;

  const now = new Date();
  await prisma.riskApproval.updateMany({
    where: {
      riskId,
      invalidatedAt: null,
      status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
    },
    data: { invalidatedAt: now, invalidatedById: actorAccountId },
  });

  // A live approval cycle can only exist inside a real multi-member org (only
  // an org member could have submitted it), so requireCallerOrganizationId is
  // safe here — the solo-admin fallback never reaches this branch.
  const organizationId = await requireCallerOrganizationId(ctx);
  for (const row of live) {
    await recordOrgAuditEvent({
      organizationId,
      action: 'RISK_APPROVAL_INVALIDATED',
      actorAccountId,
      metadata: { riskId, approvalId: row.id },
    });
  }
};

export const risk_approval_service = {
  submit_risk_for_approval,
  approve_risk,
  reject_risk,
  get_risk_approval_state,
  invalidateLiveApprovalsOnEdit,
};
