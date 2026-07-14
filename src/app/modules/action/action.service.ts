import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { AppError } from '../../utils/app_error.js';
import {
  applyActionScope,
  assertCanWriteToAction,
  assertCanWriteToInspection,
  assertIsOrgAdmin,
  CallerOrgContext,
  isMembershipActive,
  recordOrgAuditEvent,
  requireCallerOrganizationId,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';

const get_all_action_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 10;
  const searchTerm = (req.query.searchTerm as string) || '';
  const siteId = (req.query.siteId as string) || '';

  const skip = (page - 1) * limit;

  // Filtered by the org's anchor account (see org_scope.ts), not the
  // caller's own accountId — see inspection.service.ts for why.
  let whereCondition: Record<string, unknown> = {
    orgAccountId: ctx.organizationId,
  };

  if (searchTerm) {
    whereCondition.actionTitle = { contains: searchTerm, mode: 'insensitive' };
  }
  if (siteId) {
    whereCondition.siteId = siteId;
  }

  // Role scoping (issue #55 slice 3+4): Lead Auditor / scoped Viewer see
  // only actions belonging to their assigned inspections; Light User sees
  // only the specific finding(s) they've been sub-assigned, via
  // applyActionScope's LIGHT_USER branch (org_scope.ts).
  whereCondition = await applyActionScope(whereCondition, ctx);

  const [data, total] = await Promise.all([
    prisma.action.findMany({
      where: whereCondition,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        messages: {
          select: {
            id: true,
            message: true,
            senderAccountId: true,
            createdAt: true,
            updatedAt: true,
            account: {
              select: {
                profile: { select: { fullName: true, profilePhoto: true } },
                organizationProfile: {
                  select: { organizationName: true, organizationLogo: true },
                },
              },
            },
          },
        },
        site: { select: { name: true, id: true } },
      },
    }),
    prisma.action.count({ where: whereCondition }),
  ]);

  return {
    meta: { page, limit, total, totalPage: Math.ceil(total / limit) },
    data,
  };
};

const get_single_action_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as Record<string, string>;
  const whereCondition = await applyActionScope({ id, orgAccountId: ctx.organizationId }, ctx);
  const result = await prisma.action.findFirst({
    where: whereCondition,
    include: {
      messages: {
        select: {
          id: true,
          message: true,
          senderAccountId: true,
          createdAt: true,
          updatedAt: true,
          account: {
            select: {
              profile: { select: { fullName: true, profilePhoto: true } },
              organizationProfile: {
                select: { organizationName: true, organizationLogo: true },
              },
            },
          },
        },
      },
      site: { select: { name: true, id: true } },
    },
  });
  if (!result) throw new AppError('Action not found', 404);
  return result;
};

const create_action_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const body = req.body;

  const inspection = await prisma.inspection.findFirst({
    where: { id: body.inspectionId, orgAccountId: ctx.organizationId },
  });
  if (!inspection) throw new AppError('Inspection not found', 404);
  // Unlike inspection creation (ADMIN-only, no scope to create "within"),
  // a finding is created as part of doing an already-assigned inspection —
  // so a Lead Auditor can create one as long as they're assigned to the
  // parent inspection. Deliberately NOT assertCanWriteToAction — a Light
  // User works within findings they've been sub-assigned to, they never
  // create new ones (there's no existing action.id to have been assigned
  // to yet).
  await assertCanWriteToInspection(ctx, inspection.id);
  body.siteId = inspection.siteId;

  const action = await prisma.action.create({
    data: {
      orgAccountId: ctx.organizationId,
      inspectionId: body.inspectionId,
      siteId: body.siteId,
      questionId: body.questionId,
      actionTitle: body.actionTitle,
      actionDisc: body.actionDisc,
      priority: body.priority,
      dueDate: body.dueDate,
      status: body.status,
      messages: {
        create:
          body.messages?.map((msg: { message: string }) => ({
            senderAccountId: user.accountId,
            message: msg.message,
          })) || [],
      },
    },
    include: { messages: true },
  });

  return action;
};

const update_action_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.action.findFirst({
    where: { id, orgAccountId: ctx.organizationId },
  });
  if (!existing) throw new AppError('Action not found', 404);
  // assertCanWriteToAction (not assertCanWriteToInspection) so a Light User
  // sub-assigned to this specific finding can update it — e.g. mark it
  // IN_PROGRESS/COMPLETE — without gaining any broader inspection access.
  await assertCanWriteToAction(ctx, { id: existing.id, inspectionId: existing.inspectionId });
  const result = await prisma.action.update({
    where: { id },
    data: {
      ...(req.body.actionTitle !== undefined && { actionTitle: req.body.actionTitle }),
      ...(req.body.actionDisc !== undefined && { actionDisc: req.body.actionDisc }),
      ...(req.body.priority !== undefined && { priority: req.body.priority }),
      ...(req.body.dueDate !== undefined && { dueDate: req.body.dueDate }),
      ...(req.body.status !== undefined && { status: req.body.status }),
    },
  });
  return result;
};

const delete_action_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.action.findFirst({
    where: { id, orgAccountId: ctx.organizationId },
  });
  if (!existing) throw new AppError('Action not found', 404);
  // Deletion stays ADMIN/Lead-Auditor-only (assertCanWriteToInspection), not
  // opened up to a sub-assigned Light User — deleting the finding entirely
  // is a different level of authority than working the finding you were
  // handed.
  await assertCanWriteToInspection(ctx, existing.inspectionId);
  const result = await prisma.action.delete({ where: { id } });
  return result;
};

/**
 * Resolves the Action + verifies it belongs to the caller's org, in one
 * place — every finding-assignment endpoint below needs this exact lookup.
 */
const requireOrgScopedAction = async (actionId: string, ctx: CallerOrgContext) => {
  const action = await prisma.action.findFirst({
    where: { id: actionId, orgAccountId: ctx.organizationId },
  });
  if (!action) throw new AppError('Action not found', 404);
  return action;
};

/**
 * Slice 4: sub-assigns one specific finding (Action) to an internal
 * LIGHT_USER member — the real scoping mechanism org_scope.ts's
 * getAssignedActionIds relies on. Callable by ADMIN or a Lead Auditor
 * assigned to the finding's parent inspection (same authority as editing
 * the finding itself). Starts PENDING_APPROVAL if the org has
 * requireApprovalForSubAssignment enabled, otherwise ACTIVE immediately —
 * only ACTIVE (and non-revoked) grants the assignee any access.
 */
const assign_light_user_to_action = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id: actionId } = req.params as { id: string };
  const { orgMemberId } = req.body as { orgMemberId: string };

  const action = await requireOrgScopedAction(actionId, ctx);
  await assertCanWriteToInspection(ctx, action.inspectionId);
  const organizationId = await requireCallerOrganizationId(ctx);

  const member = await prisma.orgMember.findFirst({
    where: { id: orgMemberId, organizationId },
  });
  if (!member) throw new AppError('Organization member not found', 404);
  // Only LIGHT_USER is sub-assignable this way — Lead Auditor/Viewer get
  // scoped access at the inspection level via InspectionAssignment
  // instead, and an ADMIN already has full access with nothing to assign.
  if (member.role !== 'LIGHT_USER') {
    throw new AppError('Only Light User members can be sub-assigned to a finding.', 400);
  }
  // Without this, a finding can be sub-assigned to a SUSPENDED or
  // time-boxed-expired member — the row sits live in the table, and if that
  // member is later reinstated with no re-review of existing assignments,
  // they'd silently regain finding access via a row created while they had
  // no active membership at all. Found by independent review.
  if (!isMembershipActive(member)) {
    throw new AppError("This member's access to the organization is not active.", 400);
  }

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { requireApprovalForSubAssignment: true },
  });

  const existingLive = await prisma.findingAssignment.findFirst({
    where: { actionId, orgMemberId, revokedAt: null, status: { not: 'REJECTED' } },
  });
  if (existingLive) return existingLive;

  const status = organization.requireApprovalForSubAssignment ? 'PENDING_APPROVAL' : 'ACTIVE';

  let assignment;
  try {
    assignment = await prisma.findingAssignment.create({
      data: { actionId, orgMemberId, assignedById: user.accountId, status },
    });
  } catch (err) {
    // Same race as InspectionAssignment/OrgInvitation: two concurrent
    // sub-assign requests for the same (actionId, orgMemberId) pair can
    // both miss each other's row via the findFirst above; the partial
    // unique index rejects the loser, which we resolve to the winner's row
    // instead of a raw 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.findingAssignment.findFirst({
        where: { actionId, orgMemberId, revokedAt: null, status: { not: 'REJECTED' } },
      });
      if (winner) return winner;
    }
    throw err;
  }

  await recordOrgAuditEvent({
    organizationId,
    action: 'FINDING_ASSIGNMENT_CREATED',
    actorAccountId: user.accountId,
    subjectOrgMemberId: orgMemberId,
    metadata: { actionId, status, assignmentId: assignment.id },
  });

  return assignment;
};

/**
 * Soft-revokes a Light User's sub-assignment to a finding — works whether
 * the assignment is currently PENDING_APPROVAL or ACTIVE (withdrawing a
 * not-yet-approved request is as valid as ending a live one). Same
 * authority as assigning: ADMIN or a Lead Auditor assigned to the parent
 * inspection.
 */
const unassign_light_user_from_action = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id: actionId, orgMemberId } = req.params as { id: string; orgMemberId: string };

  const action = await requireOrgScopedAction(actionId, ctx);
  await assertCanWriteToInspection(ctx, action.inspectionId);
  const organizationId = await requireCallerOrganizationId(ctx);

  const member = await prisma.orgMember.findFirst({
    where: { id: orgMemberId, organizationId },
  });
  if (!member) throw new AppError('Organization member not found', 404);

  // Scoped to status: { not: 'REJECTED' } — a REJECTED row already grants no
  // access and is a terminal state; "revoking" it would set revokedAt on a
  // row that was never live, corrupting the audit trail with a
  // FINDING_ASSIGNMENT_REVOKED event for something that was actually
  // rejected. Found by independent review. The partial unique index
  // guarantees at most one such row for this (actionId, orgMemberId) pair,
  // so finding it first (rather than a bare updateMany) lets us return the
  // actual updated row instead of just echoing the request params back.
  const live = await prisma.findingAssignment.findFirst({
    where: { actionId, orgMemberId, revokedAt: null, status: { not: 'REJECTED' } },
  });

  // Surfaced as a 404 rather than a blanket 200 — a caller revoking access
  // they believe is live deserves to know when nothing was actually
  // revoked (stale UI, wrong orgMemberId, already revoked/rejected),
  // instead of walking away believing access was cut off when it wasn't.
  // Found by independent review.
  if (!live) {
    throw new AppError('No active or pending sub-assignment found for this member.', 404);
  }

  // updateMany (not update) with revokedAt: null re-checked in the
  // where-clause — the findFirst above establishes the row was live at read
  // time, but two concurrent unassign calls could both pass that check
  // before either write commits. Guarding the write itself means only the
  // first one actually revokes (and gets an audit event); the second is a
  // harmless no-op rather than silently overwriting revokedAt/revokedById a
  // second time with a duplicate FINDING_ASSIGNMENT_REVOKED entry. Found by
  // independent review.
  const { count } = await prisma.findingAssignment.updateMany({
    where: { id: live.id, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: user.accountId },
  });

  const updated = await prisma.findingAssignment.findUniqueOrThrow({ where: { id: live.id } });

  if (count === 0) {
    // Lost the race — a concurrent request already revoked this row.
    // Returning its current (already-revoked) state is still a truthful
    // answer to "is this assignment revoked now?", without a duplicate
    // audit entry for a revocation this request didn't actually perform.
    return updated;
  }

  await recordOrgAuditEvent({
    organizationId,
    action: 'FINDING_ASSIGNMENT_REVOKED',
    actorAccountId: user.accountId,
    subjectOrgMemberId: orgMemberId,
    metadata: { actionId, assignmentId: updated.id },
  });

  return updated;
};

/**
 * Resolves a FindingAssignment scoped to the caller's org — Action doesn't
 * have a direct organizationId column, only orgAccountId (the anchor), so
 * this joins through the parent Action to check it.
 */
const requireOrgScopedFindingAssignment = async (assignmentId: string, ctx: CallerOrgContext) => {
  const assignment = await prisma.findingAssignment.findFirst({
    where: { id: assignmentId, action: { orgAccountId: ctx.organizationId } },
  });
  if (!assignment) throw new AppError('Finding assignment not found', 404);
  return assignment;
};

/**
 * Admin-only. Approves a PENDING_APPROVAL sub-assignment, making it ACTIVE
 * (and therefore actually granting the assignee access — see
 * getAssignedActionIds in org_scope.ts).
 */
const approve_finding_assignment = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertIsOrgAdmin(ctx);
  const { id } = req.params as { id: string };
  const organizationId = await requireCallerOrganizationId(ctx);

  const assignment = await requireOrgScopedFindingAssignment(id, ctx);
  if (assignment.status !== 'PENDING_APPROVAL') {
    throw new AppError('Only a pending assignment can be approved.', 400);
  }
  // A row can be PENDING_APPROVAL and revoked at the same time — unassign
  // only touches revokedAt, not status (see unassign_light_user_from_action)
  // — so the status check alone isn't enough. Without this, approving a
  // withdrawn request would flip it to {status: ACTIVE, revokedAt: set},
  // recording FINDING_ASSIGNMENT_APPROVED for an assignment that was
  // already ended. It still wouldn't grant access (getAssignedActionIds
  // requires revokedAt: null too), but the corrupted state and misleading
  // audit trail defeat the whole point of that trail. Found by independent
  // review (confirmed independently by three review passes).
  if (assignment.revokedAt !== null) {
    throw new AppError('This assignment was withdrawn and can no longer be approved.', 400);
  }

  const updated = await prisma.findingAssignment.update({
    where: { id },
    data: { status: 'ACTIVE', approvedById: user.accountId },
  });

  await recordOrgAuditEvent({
    organizationId,
    action: 'FINDING_ASSIGNMENT_APPROVED',
    actorAccountId: user.accountId,
    subjectOrgMemberId: assignment.orgMemberId,
    metadata: { actionId: assignment.actionId, assignmentId: assignment.id },
  });

  return updated;
};

/**
 * Admin-only. Rejects a PENDING_APPROVAL sub-assignment — the assignee
 * never gains access (REJECTED never counts in getAssignedActionIds).
 */
const reject_finding_assignment = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertIsOrgAdmin(ctx);
  const { id } = req.params as { id: string };
  const organizationId = await requireCallerOrganizationId(ctx);

  const assignment = await requireOrgScopedFindingAssignment(id, ctx);
  if (assignment.status !== 'PENDING_APPROVAL') {
    throw new AppError('Only a pending assignment can be rejected.', 400);
  }
  // Same reasoning as approve_finding_assignment: a withdrawn (revoked)
  // request shouldn't be "rejected" too, or the audit trail records two
  // conflicting end-states for the same assignment.
  if (assignment.revokedAt !== null) {
    throw new AppError('This assignment was withdrawn and can no longer be rejected.', 400);
  }

  const updated = await prisma.findingAssignment.update({
    where: { id },
    data: { status: 'REJECTED', approvedById: user.accountId },
  });

  await recordOrgAuditEvent({
    organizationId,
    action: 'FINDING_ASSIGNMENT_REJECTED',
    actorAccountId: user.accountId,
    subjectOrgMemberId: assignment.orgMemberId,
    metadata: { actionId: assignment.actionId, assignmentId: assignment.id },
  });

  return updated;
};

/**
 * Lists sub-assignments for a finding — same authority as assigning/
 * unassigning (ADMIN or the Lead Auditor assigned to the parent
 * inspection), not exposed to the assignee themselves or to other Light
 * Users, since it can reveal who else was considered/assigned.
 */
const get_finding_assignments_for_action = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id: actionId } = req.params as { id: string };

  const action = await requireOrgScopedAction(actionId, ctx);
  await assertCanWriteToInspection(ctx, action.inspectionId);

  return prisma.findingAssignment.findMany({
    where: { actionId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      orgMember: {
        select: {
          id: true,
          role: true,
          account: { select: { email: true, profile: { select: { fullName: true } } } },
        },
      },
    },
  });
};

/**
 * Self-scoped to the caller's own OrgMember.id — no other input, so there's
 * no cross-tenant or cross-member surface to gate beyond that. Returns every
 * status (PENDING_APPROVAL/ACTIVE/REJECTED) and revoked rows, unlike
 * get_finding_assignments_for_action's ACTIVE-only management view: a Light
 * User needs to see "your request is awaiting approval" or "this assignment
 * was rejected/revoked", not just their currently-live ones. Without this, a
 * sub-assigned Light User under an org with requireApprovalForSubAssignment
 * enabled has no way to tell 'not assigned' apart from 'assigned but
 * pending' apart from 'assigned then rejected' — the general GET /action
 * list only ever shows ACTIVE assignments. Found by independent review.
 */
const get_my_finding_assignments = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  if (!ctx.orgMemberId) return [];

  return prisma.findingAssignment.findMany({
    where: { orgMemberId: ctx.orgMemberId },
    orderBy: { createdAt: 'desc' },
    include: {
      action: {
        select: { id: true, actionTitle: true, inspectionId: true, status: true },
      },
    },
  });
};

export const action_service = {
  get_all_action_from_db,
  get_single_action_from_db,
  create_action_into_db,
  update_action_into_db,
  delete_action_from_db,
  assign_light_user_to_action,
  unassign_light_user_from_action,
  approve_finding_assignment,
  reject_finding_assignment,
  get_finding_assignments_for_action,
  get_my_finding_assignments,
};
