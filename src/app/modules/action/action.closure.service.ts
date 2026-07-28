import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import {
  assertCanWriteOrgResource,
  assertCanWriteToAction,
  CallerOrgContext,
  recordOrgAuditEvent,
  requireCallerOrganizationId,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';

/**
 * Finding closure maker-checker approval workflow (aexa-server#252).
 *
 * Structural twin of risk.approval.service.ts's Risk approval flow: someone
 * submits a finding's closure request, a second person (ADMIN or
 * LEAD_AUDITOR, never the submitter) approves or rejects it, and every
 * transition writes an OrgAuditLog row. `invalidatedAt` plays the same
 * soft-supersede role — an edit to the finding after submission forces a
 * fresh submission, since the content being closed has changed.
 *
 * The one structural difference from RiskApproval: Action.status itself is
 * gated by this cycle for its two terminal values (COMPLETE, CANT_DO) — see
 * action.service.ts's update_action_into_db, which now rejects a direct
 * PATCH to either. Submitting for closure does NOT change Action.status;
 * only an APPROVED cycle does, atomically with the decision.
 *
 * A "live" cycle is one that still represents the current, un-decided
 * closure request: `invalidatedAt IS NULL AND status != 'REJECTED'`. The
 * partial unique index in the migration guarantees at most one live cycle
 * per action.
 */

const CLOSURE_TERMINAL_STATUSES = ['COMPLETE', 'CANT_DO'] as const;
type ClosureTerminalStatus = (typeof CLOSURE_TERMINAL_STATUSES)[number];

export const isClosureTerminalStatus = (status: unknown): status is ClosureTerminalStatus =>
  typeof status === 'string' && (CLOSURE_TERMINAL_STATUSES as readonly string[]).includes(status);

/**
 * Resolves an Action scoped to the caller's org, or 404s. Mirrors
 * action.service.ts's own ownership check.
 */
const requireOrgScopedAction = async (actionId: string, ctx: CallerOrgContext) => {
  const action = await prisma.action.findFirst({
    where: { id: actionId, orgAccountId: ctx.organizationId },
  });
  if (!action) throw new AppError('Action not found', 404);
  return action;
};

/**
 * Resolves an ActionClosureApproval scoped to the caller's org — the model
 * has no orgAccountId column, so this joins through its parent Action,
 * exactly like risk.approval.service.ts's requireOrgScopedApproval.
 */
const requireOrgScopedClosureApproval = async (closureId: string, ctx: CallerOrgContext) => {
  const closure = await prisma.actionClosureApproval.findFirst({
    where: { id: closureId, action: { orgAccountId: ctx.organizationId } },
  });
  if (!closure) throw new AppError('Closure request not found', 404);
  return closure;
};

/**
 * Derives the display-facing closure state for a finding from its most
 * recent closure cycle. An invalidated latest cycle reads as NOT_SUBMITTED
 * — the finding changed since submission, so a fresh request is required.
 */
export type ClosureDisplayState = 'NOT_SUBMITTED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

export const deriveClosureState = (
  latest: { status: string; invalidatedAt: Date | null } | null,
): ClosureDisplayState => {
  if (!latest) return 'NOT_SUBMITTED';
  if (latest.invalidatedAt !== null) return 'NOT_SUBMITTED';
  return latest.status as 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
};

/**
 * ADMIN/LEAD_AUDITOR, or a sub-assigned LIGHT_USER (same access as a normal
 * finding edit — assertCanWriteToAction) — submitting for closure isn't a
 * privileged act by itself, only the sign-off is. Creates a PENDING_APPROVAL
 * cycle requesting `requestedStatus` (COMPLETE or CANT_DO); does NOT change
 * Action.status. Requires at least one attachment on the finding (aexa-
 * server#243's evidence-gate precedent: an unbacked closure claim isn't a
 * real gap fix). Blocks if a live cycle already exists.
 */
const submit_action_for_closure = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id: actionId } = req.params as { id: string };
  const { requestedStatus } = req.body as { requestedStatus: string };

  const action = await requireOrgScopedAction(actionId, ctx);
  await assertCanWriteToAction(ctx, { id: action.id, inspectionId: action.inspectionId });

  if (!isClosureTerminalStatus(requestedStatus)) {
    throw new AppError("requestedStatus must be 'COMPLETE' or 'CANT_DO'.", 400);
  }
  if (!action.attachments || action.attachments.length === 0) {
    throw new AppError(
      'A finding requires at least one evidence attachment before it can be submitted for closure.',
      400,
    );
  }

  const organizationId = await requireCallerOrganizationId(ctx);

  const liveWhere: Prisma.ActionClosureApprovalWhereInput = {
    actionId,
    invalidatedAt: null,
    status: { not: 'REJECTED' },
  };
  const existingLive = await prisma.actionClosureApproval.findFirst({ where: liveWhere });
  if (existingLive) {
    if (existingLive.status === 'PENDING_APPROVAL') {
      throw new AppError('This finding already has a pending closure request.', 409);
    }
    throw new AppError(
      'This finding is already approved for closure. Edit it to require a fresh request.',
      409,
    );
  }

  let closure;
  try {
    closure = await prisma.actionClosureApproval.create({
      data: {
        actionId,
        requestedStatus,
        submittedById: user.accountId,
        status: 'PENDING_APPROVAL',
      },
    });
  } catch (err) {
    // Same race as risk.approval.service.ts's submit_risk_for_approval: two
    // concurrent submissions can both miss each other via findFirst; the
    // partial unique index rejects the loser.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.actionClosureApproval.findFirst({ where: liveWhere });
      if (winner) return winner;
      throw new AppError(
        'Could not submit this finding for closure due to a concurrent update. Please retry.',
        409,
      );
    }
    throw err;
  }

  await recordOrgAuditEvent({
    organizationId,
    action: 'ACTION_CLOSURE_SUBMITTED',
    actorAccountId: user.accountId,
    metadata: { actionId, closureId: closure.id, requestedStatus },
  });

  return closure;
};

/**
 * ADMIN/LEAD_AUDITOR. Approves a PENDING_APPROVAL cycle and atomically
 * applies its requestedStatus to Action.status — the only path by which a
 * finding reaches COMPLETE or CANT_DO. Same maker-checker separation as
 * risk.approval.service.ts's approve_risk: the submitter can never be the
 * approver, or the two-person control is theatre.
 */
const approve_action_closure = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as { id: string };
  const organizationId = await requireCallerOrganizationId(ctx);

  const closure = await requireOrgScopedClosureApproval(id, ctx);
  if (closure.submittedById === user.accountId) {
    throw new AppError(
      'You cannot approve your own closure submission — ask another admin or lead auditor to review it.',
      403,
    );
  }
  if (closure.status !== 'PENDING_APPROVAL') {
    throw new AppError('Only a pending closure request can be approved.', 400);
  }
  if (closure.invalidatedAt !== null) {
    throw new AppError(
      'This finding was edited after submission and must be resubmitted for closure.',
      400,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    // Concurrency guard (mirrors approve_risk): re-assert the expected prior
    // state in the updateMany where-clause so only the request that still
    // finds a live pending row transitions it.
    const { count } = await tx.actionClosureApproval.updateMany({
      where: { id, status: 'PENDING_APPROVAL', invalidatedAt: null },
      data: { status: 'APPROVED', decidedById: user.accountId, decidedAt: new Date() },
    });
    if (count === 0) {
      throw new AppError(
        'This closure request was already decided or invalidated by another request.',
        409,
      );
    }
    const updatedClosure = await tx.actionClosureApproval.findUniqueOrThrow({ where: { id } });
    const updatedAction = await tx.action.update({
      where: { id: closure.actionId },
      data: { status: updatedClosure.requestedStatus },
    });
    return { closure: updatedClosure, action: updatedAction };
  });

  await recordOrgAuditEvent({
    organizationId,
    action: 'ACTION_CLOSURE_APPROVED',
    actorAccountId: user.accountId,
    metadata: { actionId: closure.actionId, closureId: closure.id },
  });

  return result;
};

/**
 * ADMIN/LEAD_AUDITOR. Rejects a PENDING_APPROVAL cycle, recording a required
 * reason. Action.status is untouched (it was never advanced while pending),
 * so rejection simply leaves the finding at whatever status it already had
 * — no explicit "reopen" transition is needed.
 */
const reject_action_closure = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as { id: string };
  const { decisionNote } = req.body as { decisionNote?: string };
  const organizationId = await requireCallerOrganizationId(ctx);

  if (!decisionNote?.trim()) {
    throw new AppError('decisionNote is required when rejecting a closure request.', 400);
  }

  const closure = await requireOrgScopedClosureApproval(id, ctx);
  if (closure.submittedById === user.accountId) {
    throw new AppError(
      'You cannot reject your own closure submission — ask another admin or lead auditor to review it.',
      403,
    );
  }
  if (closure.status !== 'PENDING_APPROVAL') {
    throw new AppError('Only a pending closure request can be rejected.', 400);
  }
  if (closure.invalidatedAt !== null) {
    throw new AppError(
      'This finding was edited after submission and must be resubmitted for closure.',
      400,
    );
  }

  const { count } = await prisma.actionClosureApproval.updateMany({
    where: { id, status: 'PENDING_APPROVAL', invalidatedAt: null },
    data: {
      status: 'REJECTED',
      decidedById: user.accountId,
      decidedAt: new Date(),
      decisionNote: decisionNote.trim(),
    },
  });
  if (count === 0) {
    throw new AppError(
      'This closure request was already decided or invalidated by another request.',
      409,
    );
  }
  const updated = await prisma.actionClosureApproval.findUniqueOrThrow({ where: { id } });

  await recordOrgAuditEvent({
    organizationId,
    action: 'ACTION_CLOSURE_REJECTED',
    actorAccountId: user.accountId,
    metadata: {
      actionId: closure.actionId,
      closureId: closure.id,
      decisionNote: decisionNote.trim(),
    },
  });

  return updated;
};

/**
 * Any active org member scoped to the finding may read its closure state
 * (it backs a per-finding badge). Returns the derived state plus the latest
 * cycle for detail rendering.
 */
const get_action_closure_state = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id: actionId } = req.params as { id: string };

  await requireOrgScopedAction(actionId, ctx);

  const latest = await prisma.actionClosureApproval.findFirst({
    where: { actionId },
    orderBy: { createdAt: 'desc' },
  });

  return { actionId, status: deriveClosureState(latest), closure: latest };
};

/**
 * Edit hook, called from update_action_into_db AND
 * update_action_for_external_member. Invalidates any live (PENDING_APPROVAL
 * or APPROVED, non-invalidated) closure cycle for a finding that's being
 * edited: the content being closed has changed, so the prior cycle no
 * longer reflects reality and a fresh submission is required. No-op (and no
 * audit write) when there's no live cycle.
 *
 * Covers APPROVED (not just PENDING_APPROVAL) so that editing a
 * finding's evidence/Five Cs *after* its closure was signed off invalidates
 * that sign-off instead of leaving it standing against content nobody
 * actually reviewed (aexa-server#258) — mirrors risk.approval.service.ts's
 * invalidateLiveApprovalsOnEdit, which invalidates both statuses for the
 * same reason.
 *
 * Takes a lazy Organization.id resolver rather than a resolved string or a
 * CallerOrgContext, for two reasons: (1) both caller shapes can supply one
 * without one having to impersonate the other — the internal path resolves
 * via requireCallerOrganizationId(ctx), the external-member path already
 * has it on ExternalCallerContext.orgId; (2) staying lazy preserves the
 * original behavior for the common no-live-cycle case — a solo-admin
 * (no real Organization) editing an action with nothing pending must not
 * throw just because resolving an org id eagerly would fail for them,
 * mirroring risk.approval.service.ts's invalidateLiveApprovalsOnEdit, which
 * resolves organizationId only after confirming there's live work to log.
 */
const invalidateLiveClosureApprovalsOnEdit = async (
  actionId: string,
  resolveOrganizationId: () => Promise<string>,
  actorAccountId: string,
  // The finding edit and this invalidation must commit or roll back
  // together, same rationale as risk.approval.service.ts's
  // invalidateLiveApprovalsOnEdit (aexa-server#203's precedent).
  client: Prisma.TransactionClient = prisma,
  // aexa-server#258 review: if the SAME edit already set Action.status
  // explicitly (only ever to a non-terminal value — isClosureTerminalStatus
  // blocks a direct PATCH to COMPLETE/CANT_DO at both call sites), that
  // explicit choice must win. Without this, an admin who PATCHes
  // {status: 'TO_DO', ...} on a COMPLETE finding with a live APPROVED cycle
  // would have their explicit TO_DO silently overwritten with IN_PROGRESS by
  // this hook running after the edit in the same transaction — breaking the
  // documented "reverting away from a terminal status" case in
  // action.service.ts's update_action_into_db.
  callerExplicitlySetStatus = false,
): Promise<void> => {
  const live = await client.actionClosureApproval.findMany({
    where: {
      actionId,
      invalidatedAt: null,
      status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
    },
    select: { id: true, status: true },
  });
  if (live.length === 0) return;

  const now = new Date();
  await client.actionClosureApproval.updateMany({
    where: {
      actionId,
      invalidatedAt: null,
      status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
    },
    data: { invalidatedAt: now, invalidatedById: actorAccountId },
  });

  // Action.status only ever reaches COMPLETE/CANT_DO via an APPROVED cycle
  // (approve_action_closure sets it atomically with the approval). If the
  // cycle being invalidated here was APPROVED, the finding's terminal status
  // was set by that now-invalidated sign-off and must revert with it —
  // otherwise the finding keeps showing COMPLETE/CANT_DO against content
  // nobody actually re-reviewed, which is the exact hole aexa-server#258
  // reported. IN_PROGRESS (not TO_DO) since the finding was actively being
  // worked, not reset to square one.
  //
  // Skipped when the caller's own PATCH already set status explicitly
  // (callerExplicitlySetStatus) — that can only be a non-terminal value
  // (isClosureTerminalStatus blocks a direct PATCH to COMPLETE/CANT_DO), so
  // it's the caller intentionally reverting away from the terminal status
  // themselves, e.g. {status: 'TO_DO'}. Forcing IN_PROGRESS over that
  // explicit choice would silently overwrite it.
  if (!callerExplicitlySetStatus && live.some((row) => row.status === 'APPROVED')) {
    await client.action.update({
      where: { id: actionId },
      data: { status: 'IN_PROGRESS' },
    });
  }

  const organizationId = await resolveOrganizationId();
  for (const row of live) {
    await recordOrgAuditEvent({
      organizationId,
      action: 'ACTION_CLOSURE_INVALIDATED',
      actorAccountId,
      metadata: { actionId, closureId: row.id },
    });
  }
};

export const action_closure_service = {
  submit_action_for_closure,
  approve_action_closure,
  reject_action_closure,
  get_action_closure_state,
  invalidateLiveClosureApprovalsOnEdit,
};
