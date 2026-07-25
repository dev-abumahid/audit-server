import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { AppError } from '../../utils/app_error.js';
import uploadCloud from '../../utils/cloudinary.js';
import {
  applyActionScope,
  assertCanWriteOrgResource,
  assertCanWriteToAction,
  assertCanWriteToActionForExternalMember,
  assertCanWriteToInspection,
  assertIsOrgAdmin,
  CallerOrgContext,
  ExternalCallerContext,
  hasActiveFindingAssignmentForExternalMember,
  isExternalMembershipActive,
  isMembershipActive,
  recordOrgAuditEvent,
  requireCallerOrganizationId,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';

// Shared by every read path that returns an Action, so "assignBy" is always
// shaped the same way the frontend's TAssignBy[] type expects ({id, name}),
// not the raw nested Prisma relation shape.
const RESPONSIBLE_INCLUDE = {
  responsibleAssignees: {
    include: {
      orgMember: {
        include: { account: { include: { profile: { select: { fullName: true } } } } },
      },
    },
  },
} satisfies Prisma.ActionInclude;

// Was duplicated identically across get_all_action_from_db,
// get_single_action_from_db, and get_single_action_for_external_member —
// extracted once a 4th call site (update_action_messages_into_db) needed
// the same shape. Found by independent review.
const MESSAGES_INCLUDE = {
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
} satisfies Prisma.ActionInclude;

type ActionWithResponsibles = Prisma.ActionGetPayload<{ include: typeof RESPONSIBLE_INCLUDE }>;

// aexa-frontend's IAction.assignBy is TAssignBy[] ({id, name}) — id is the
// OrgMember id (see ActionResponsible's schema comment for why), name falls
// back to email when no profile fullName is set, matching how member lists
// are already displayed elsewhere (organization.service.ts).
//
// Generic so callers that also include messages/site (get_single_action_from_db
// etc.) get those fields preserved in the return type -- a non-generic
// parameter type here would silently narrow them away even though they're
// genuinely present on the runtime object, same class of gap as issue #52's
// original assignBy bug. Found by independent review.
const shapeResponsibleAssignees = <T extends ActionWithResponsibles>(action: T) => {
  const { responsibleAssignees, ...rest } = action;
  return {
    ...rest,
    // Every real Prisma call above always passes RESPONSIBLE_INCLUDE, so
    // this is only ever undefined in a test double that doesn't bother
    // replicating the full nested include shape — not a real-world case.
    assignBy: (responsibleAssignees ?? []).map((r) => ({
      id: r.orgMemberId,
      name: r.orgMember.account.profile?.fullName || r.orgMember.account.email,
    })),
  };
};

const get_all_action_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const searchTerm = (req.query.searchTerm as string) || '';
  const siteId = (req.query.siteId as string) || '';
  const inspectionId = (req.query.inspectionId as string) || '';

  const pagination = paginationHelper({
    page: req.query.page as string,
    limit: req.query.limit as string,
  });
  const { skip, limit } = pagination;

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
  if (inspectionId) {
    whereCondition.inspectionId = inspectionId;
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
        // List rows only need a message *count* for the "Messages" badge
        // (aexa-frontend's AllFindingsPage.tsx reads `action.messages?.length`)
        // -- not the full nested MESSAGES_INCLUDE (sender account/profile,
        // message bodies) that every row was paying for on every list fetch.
        // Detail fetches (get_single_action_from_db) still use the full
        // MESSAGES_INCLUDE below; aexa-frontend's edit-from-list flow now
        // fetches GET /action/:id for that instead of relying on this list
        // payload (Qiyrix/aexa-frontend#119, landing with/before this PR).
        // See issue #162 (follow-up to #126).
        messages: { select: { id: true } },
        site: { select: { name: true, id: true } },
        ...RESPONSIBLE_INCLUDE,
      },
    }),
    prisma.action.count({ where: whereCondition }),
  ]);

  return {
    meta: buildPaginationMeta(pagination, total),
    data: data.map(shapeResponsibleAssignees),
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
      ...MESSAGES_INCLUDE,
      site: { select: { name: true, id: true } },
      ...RESPONSIBLE_INCLUDE,
    },
  });
  if (!result) throw new AppError('Action not found', 404);
  return shapeResponsibleAssignees(result);
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

  // questionId is optional but, when present, was stored with no ownership
  // check at all — the same IDOR pattern already fixed for inspectionId/
  // siteId/templateId elsewhere (issues #23-26), just not covered by that
  // pass. A caller who owns inspectionId (checked above) could otherwise
  // pass a questionId belonging to a completely different org's template,
  // associating/leaking that org's question content into their own action
  // record. Found by independent review (issue #50).
  if (body.questionId) {
    const question = await prisma.question.findFirst({
      where: { id: body.questionId, page: { template: { orgAccountId: ctx.organizationId } } },
    });
    if (!question) throw new AppError('Question not found', 404);
  }

  // complianceObligationId is optional (the "Create Action from a non-compliant
  // obligation" flow, aexa-frontend#166) but, when present, must belong to the
  // caller's own org — same IDOR guard as questionId above. ComplianceObligation
  // is org-scoped via org_account_id (the anchor Account id, i.e.
  // ctx.organizationId — see compliance.service.ts), so a plain findFirst on
  // { id, org_account_id } is the right ownership check. Without it a caller
  // could stamp their action with another org's obligation id.
  if (body.complianceObligationId) {
    const obligation = await prisma.complianceObligation.findFirst({
      where: { id: body.complianceObligationId, org_account_id: ctx.organizationId },
    });
    if (!obligation) throw new AppError('Compliance obligation not found', 404);
  }

  // Every assignBy id must be a real OrgMember in the caller's own org —
  // without this, any org could tag an arbitrary orgMemberId from a
  // completely different org as "responsible" for their finding, the same
  // IDOR class as the questionId check above. 404s (via
  // requireOrgScopedMember) before the Action is ever created.
  //
  // requireOrgScopedMember filters by the real Organization.id, NOT
  // ctx.organizationId (that's the anchor Account.id used by legacy
  // orgAccountId columns -- see requireCallerOrganizationId's own doc
  // comment). Passing ctx.organizationId here would 404 every legitimate
  // assignBy id in production, since those two ids are never equal. Only
  // resolved when actually needed so an ADMIN-of-self account (no real
  // OrgMember row, the pre-multi-tenant fallback) isn't broken by
  // requireCallerOrganizationId's 403 on a plain create with no assignees.
  const assigneeIds: string[] = body.assignBy ?? [];
  if (assigneeIds.length > 0) {
    const organizationId = await requireCallerOrganizationId(ctx);
    await requireOrgScopedMembers(assigneeIds, organizationId);
  }

  const action = await prisma.action.create({
    data: {
      orgAccountId: ctx.organizationId,
      inspectionId: body.inspectionId,
      siteId: body.siteId,
      questionId: body.questionId,
      // Set once at creation only — like siteId/questionId, the compliance
      // link is not part of update_action_into_db's writable field set
      // (which never re-checks foreign ownership), so it can't be re-pointed
      // to an unowned obligation via a later PATCH.
      complianceObligationId: body.complianceObligationId,
      actionTitle: body.actionTitle,
      actionDisc: body.actionDisc,
      priority: body.priority,
      dueDate: body.dueDate,
      status: body.status,
      // #97: required by action.validation.ts's create_action schema for
      // every new Action — no default, unlike the other 4 models this
      // classification touches (see action.prisma's schema comment). No
      // extra role gate needed here beyond assertCanWriteToInspection above:
      // that already restricts action creation to ADMIN/LEAD_AUDITOR, the
      // same set allowed to reassign line_of_defense on update.
      line_of_defense: body.line_of_defense,
      attachments: body.attachments ?? [],
      messages: {
        create:
          body.messages?.map((msg: { message: string }) => ({
            senderAccountId: user.accountId,
            message: msg.message,
          })) || [],
      },
      responsibleAssignees: {
        create: assigneeIds.map((orgMemberId) => ({ orgMemberId })),
      },
    },
    include: { messages: true, ...RESPONSIBLE_INCLUDE },
  });

  return shapeResponsibleAssignees(action);
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

  // #97: reassigning line_of_defense is restricted to ADMIN/LEAD_AUDITOR
  // (the org_scope.ts gate every other module's update endpoint uses via
  // assertCanWriteOrgResource), which is STRICTER than assertCanWriteToAction
  // above — that check also lets a sub-assigned LIGHT_USER update a finding's
  // other fields (status, attachments, etc.), and a Light User must not be
  // able to reclassify a finding's governance line. Only run this extra gate
  // when line_of_defense is actually part of the payload, same "only check
  // what's touched" pattern assignBy already uses just below.
  if (req.body.line_of_defense !== undefined) {
    assertCanWriteOrgResource(ctx);
  }

  // Same org-scope check as create — only run when assignBy is actually
  // part of this update, same as every other optional field here. See the
  // matching comment in create_action_into_db for why this resolves the
  // real Organization.id via requireCallerOrganizationId instead of using
  // ctx.organizationId directly.
  if (req.body.assignBy !== undefined) {
    const assigneeIds: string[] = req.body.assignBy;
    if (assigneeIds.length > 0) {
      const organizationId = await requireCallerOrganizationId(ctx);
      await requireOrgScopedMembers(assigneeIds, organizationId);
    }
  }

  const result = await prisma.action.update({
    where: { id },
    data: {
      ...(req.body.actionTitle !== undefined && { actionTitle: req.body.actionTitle }),
      ...(req.body.actionDisc !== undefined && { actionDisc: req.body.actionDisc }),
      ...(req.body.priority !== undefined && { priority: req.body.priority }),
      ...(req.body.dueDate !== undefined && { dueDate: req.body.dueDate }),
      ...(req.body.status !== undefined && { status: req.body.status }),
      ...(req.body.attachments !== undefined && { attachments: req.body.attachments }),
      ...(req.body.line_of_defense !== undefined && {
        line_of_defense: req.body.line_of_defense,
      }),
      // Full replace, not a merge — matches how the frontend's multi-select
      // submits the complete desired set every time, not a delta.
      ...(req.body.assignBy !== undefined && {
        responsibleAssignees: {
          deleteMany: {},
          create: (req.body.assignBy as string[]).map((orgMemberId) => ({ orgMemberId })),
        },
      }),
    },
    include: { ...RESPONSIBLE_INCLUDE },
  });
  return shapeResponsibleAssignees(result);
};

/**
 * Uploads a corrective-action attachment to S3 and returns its URL. This is
 * a two-step flow, same as inspection's upload-file-aws: the frontend
 * uploads the file here first, then includes the returned URL in the
 * `attachments` array on a subsequent create/update call — this endpoint
 * itself doesn't touch any Action row, so it only needs auth, not
 * org-scoped lookup. Response shape ({ url }) intentionally differs from
 * upload-file-aws's bare-string response — this one matches what
 * aexa-frontend's InspectionActions.tsx already expects (`json.data?.url`),
 * fixed by consumer, not by this endpoint choosing its own shape freely.
 */
const upload_action_attachment_into_aws = async (req: Request) => {
  const file = req.file;
  if (!file) {
    throw new AppError('File is required', 400);
  }
  const result = await uploadCloud(file);
  return { url: result.secure_url };
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
 * Resolves an internal OrgMember scoped to the caller's org, 404 if missing
 * — shared by assign_light_user_to_action and unassign_light_user_from_action
 * so this exact lookup isn't hand-copied at both call sites.
 */
const requireOrgScopedMember = async (orgMemberId: string, organizationId: string) => {
  const member = await prisma.orgMember.findFirst({ where: { id: orgMemberId, organizationId } });
  if (!member) throw new AppError('Organization member not found', 404);
  return member;
};

/**
 * Batched counterpart to requireOrgScopedMember for the assignBy validation
 * in create_action_into_db/update_action_into_db — those pass a whole array
 * of candidate orgMemberIds, so this issues one `findMany({ id: { in } })`
 * instead of a query per id (issue #135). Membership in the returned set is
 * checked per requested id (not by comparing array lengths) so a caller-
 * supplied duplicate id can't mask a genuinely missing/cross-org id.
 */
const requireOrgScopedMembers = async (orgMemberIds: string[], organizationId: string) => {
  const members = await prisma.orgMember.findMany({
    where: { id: { in: orgMemberIds }, organizationId },
  });
  const foundIds = new Set(members.map((member) => member.id));
  const missingId = orgMemberIds.find((id) => !foundIds.has(id));
  if (missingId) throw new AppError('Organization member not found', 404);
  return members;
};

/**
 * External-member counterpart to requireOrgScopedMember, shared by
 * assign_light_user_to_action and unassign_external_light_user_from_action.
 */
const requireOrgScopedExternalMember = async (
  externalOrgMemberId: string,
  organizationId: string,
) => {
  const member = await prisma.externalOrgMember.findFirst({
    where: { id: externalOrgMemberId, organizationId },
  });
  if (!member) throw new AppError('External organization member not found', 404);
  return member;
};

/**
 * Slice 4: sub-assigns one specific finding (Action) to an internal
 * LIGHT_USER member — the real scoping mechanism org_scope.ts's
 * getAssignedActionIds relies on. Callable by ADMIN or a Lead Auditor
 * assigned to the finding's parent inspection (same authority as editing
 * the finding itself). Starts PENDING_APPROVAL if the org has
 * requireApprovalForSubAssignment enabled, otherwise ACTIVE immediately —
 * only ACTIVE (and non-revoked) grants the assignee any access.
 *
 * Slice 5 extends this to an external Light User via body.externalOrgMemberId
 * — exactly one of orgMemberId/externalOrgMemberId is ever present
 * (enforced by action.validation.ts's assign_light_user schema). The two
 * target types share every rule (member must exist in this org, be
 * LIGHT_USER, be active, respect the approval toggle, dedupe against an
 * existing live row, resolve the same P2002 race) — only the table queried
 * and the partial-unique-index race-key differ, so this stays one function
 * with a branch rather than two near-duplicate ones.
 */
const assign_light_user_to_action = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id: actionId } = req.params as { id: string };
  const { orgMemberId, externalOrgMemberId } = req.body as {
    orgMemberId?: string;
    externalOrgMemberId?: string;
  };

  const action = await requireOrgScopedAction(actionId, ctx);
  await assertCanWriteToInspection(ctx, action.inspectionId);
  const organizationId = await requireCallerOrganizationId(ctx);

  let targetData: Omit<Prisma.FindingAssignmentUncheckedCreateInput, 'assignedById' | 'status'>;
  let liveWhere: Prisma.FindingAssignmentWhereInput;
  let subjectOrgMemberId: string | null = null;
  let subjectExternalOrgMemberId: string | null = null;

  if (orgMemberId) {
    const member = await requireOrgScopedMember(orgMemberId, organizationId);
    // Only LIGHT_USER is sub-assignable this way — Lead Auditor/Viewer get
    // scoped access at the inspection level via InspectionAssignment
    // instead, and an ADMIN already has full access with nothing to assign.
    if (member.role !== 'LIGHT_USER') {
      throw new AppError('Only Light User members can be sub-assigned to a finding.', 400);
    }
    // Without this, a finding can be sub-assigned to a SUSPENDED or
    // time-boxed-expired member — the row sits live in the table, and if
    // that member is later reinstated with no re-review of existing
    // assignments, they'd silently regain finding access via a row created
    // while they had no active membership at all. Found by independent
    // review.
    if (!isMembershipActive(member)) {
      throw new AppError("This member's access to the organization is not active.", 400);
    }
    targetData = { actionId, orgMemberId };
    liveWhere = { actionId, orgMemberId, revokedAt: null, status: { not: 'REJECTED' } };
    subjectOrgMemberId = orgMemberId;
  } else {
    const member = await requireOrgScopedExternalMember(
      externalOrgMemberId as string,
      organizationId,
    );
    if (member.role !== 'LIGHT_USER') {
      throw new AppError('Only Light User members can be sub-assigned to a finding.', 400);
    }
    if (!isExternalMembershipActive(member)) {
      throw new AppError("This member's access to the organization is not active.", 400);
    }
    targetData = { actionId, externalOrgMemberId };
    liveWhere = { actionId, externalOrgMemberId, revokedAt: null, status: { not: 'REJECTED' } };
    subjectExternalOrgMemberId = externalOrgMemberId as string;
  }

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { requireApprovalForSubAssignment: true },
  });

  const existingLive = await prisma.findingAssignment.findFirst({ where: liveWhere });
  if (existingLive) return existingLive;

  const status = organization.requireApprovalForSubAssignment ? 'PENDING_APPROVAL' : 'ACTIVE';

  let assignment;
  try {
    assignment = await prisma.findingAssignment.create({
      data: { ...targetData, assignedById: user.accountId, status },
    });
  } catch (err) {
    // Same race as InspectionAssignment/OrgInvitation: two concurrent
    // sub-assign requests for the same (actionId, orgMemberId) pair can
    // both miss each other's row via the findFirst above; the partial
    // unique index rejects the loser, which we resolve to the winner's row
    // instead of a raw 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.findingAssignment.findFirst({ where: liveWhere });
      if (winner) return winner;
    }
    throw err;
  }

  await recordOrgAuditEvent({
    organizationId,
    action: 'FINDING_ASSIGNMENT_CREATED',
    actorAccountId: user.accountId,
    subjectOrgMemberId,
    subjectExternalOrgMemberId,
    metadata: { actionId, status, assignmentId: assignment.id },
  });

  return assignment;
};

/**
 * Shared revoke logic for both unassign_light_user_from_action and
 * unassign_external_light_user_from_action — everything past "which member
 * table did this row's target come from" is identical, so this stays one
 * function with the target-specific where-clause/subject id passed in,
 * rather than two near-duplicate copies.
 */
const revokeLiveFindingAssignment = async (params: {
  liveWhere: Prisma.FindingAssignmentWhereInput;
  organizationId: string;
  actorAccountId: string;
  subjectOrgMemberId?: string | null;
  subjectExternalOrgMemberId?: string | null;
  actionId: string;
}) => {
  // Scoped to status: { not: 'REJECTED' } — a REJECTED row already grants no
  // access and is a terminal state; "revoking" it would set revokedAt on a
  // row that was never live, corrupting the audit trail with a
  // FINDING_ASSIGNMENT_REVOKED event for something that was actually
  // rejected. Found by independent review. The partial unique index
  // guarantees at most one such row for this pair, so finding it first
  // (rather than a bare updateMany) lets us return the actual updated row
  // instead of just echoing the request params back.
  const live = await prisma.findingAssignment.findFirst({ where: params.liveWhere });

  // Surfaced as a 404 rather than a blanket 200 — a caller revoking access
  // they believe is live deserves to know when nothing was actually
  // revoked (stale UI, wrong member id, already revoked/rejected), instead
  // of walking away believing access was cut off when it wasn't. Found by
  // independent review.
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
    data: { revokedAt: new Date(), revokedById: params.actorAccountId },
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
    organizationId: params.organizationId,
    action: 'FINDING_ASSIGNMENT_REVOKED',
    actorAccountId: params.actorAccountId,
    subjectOrgMemberId: params.subjectOrgMemberId ?? null,
    subjectExternalOrgMemberId: params.subjectExternalOrgMemberId ?? null,
    metadata: { actionId: params.actionId, assignmentId: updated.id },
  });

  return updated;
};

/**
 * Soft-revokes an internal Light User's sub-assignment to a finding — works
 * whether the assignment is currently PENDING_APPROVAL or ACTIVE (withdrawing
 * a not-yet-approved request is as valid as ending a live one). Same
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

  await requireOrgScopedMember(orgMemberId, organizationId);

  return revokeLiveFindingAssignment({
    liveWhere: { actionId, orgMemberId, revokedAt: null, status: { not: 'REJECTED' } },
    organizationId,
    actorAccountId: user.accountId,
    subjectOrgMemberId: orgMemberId,
    actionId,
  });
};

/**
 * Slice 5: external-member counterpart to unassign_light_user_from_action —
 * identical rule, just scoped to ExternalOrgMember/externalOrgMemberId
 * instead of OrgMember/orgMemberId.
 */
const unassign_external_light_user_from_action = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id: actionId, externalOrgMemberId } = req.params as {
    id: string;
    externalOrgMemberId: string;
  };

  const action = await requireOrgScopedAction(actionId, ctx);
  await assertCanWriteToInspection(ctx, action.inspectionId);
  const organizationId = await requireCallerOrganizationId(ctx);

  await requireOrgScopedExternalMember(externalOrgMemberId, organizationId);

  return revokeLiveFindingAssignment({
    liveWhere: { actionId, externalOrgMemberId, revokedAt: null, status: { not: 'REJECTED' } },
    organizationId,
    actorAccountId: user.accountId,
    subjectExternalOrgMemberId: externalOrgMemberId,
    actionId,
  });
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
    subjectExternalOrgMemberId: assignment.externalOrgMemberId,
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
    subjectExternalOrgMemberId: assignment.externalOrgMemberId,
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
      // Slice 5: exactly one of orgMember/externalOrgMember is populated per
      // row (mirrors the two mutually-exclusive partial unique indexes on
      // FindingAssignment) — including both relations lets the caller render
      // either kind without a second lookup.
      externalOrgMember: {
        select: { id: true, role: true, email: true, fullName: true },
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

/**
 * Slice 5: external-member counterpart to get_my_finding_assignments — same
 * shape and same "every status, not just ACTIVE" reasoning, keyed by
 * externalOrgMemberId instead of orgMemberId. Called from a route gated by
 * authExternal, not auth('ORGANIZATION'), so there's no internal
 * CallerOrgContext to resolve here at all.
 */
const get_my_finding_assignments_external = async (req: Request) => {
  const externalMember = req.externalMember as ExternalCallerContext;

  return prisma.findingAssignment.findMany({
    where: { externalOrgMemberId: externalMember.externalOrgMemberId },
    orderBy: { createdAt: 'desc' },
    include: {
      action: {
        select: { id: true, actionTitle: true, inspectionId: true, status: true },
      },
    },
  });
};

/**
 * Slice 5: external-member counterpart to get_single_action_from_db — an
 * external Light User may view exactly the findings they hold a live
 * FindingAssignment for, nothing else, so this doesn't go through
 * applyActionScope at all (that function has no external-member branch —
 * see hasActiveFindingAssignmentForExternalMember's docstring in
 * org_scope.ts). Uses the targeted single-id check, not
 * getAssignedActionIdsForExternalMember — this only needs a yes/no answer
 * for one action, not the member's full assignment list.
 */
const get_single_action_for_external_member = async (req: Request) => {
  const externalMember = req.externalMember as ExternalCallerContext;
  const { id } = req.params as Record<string, string>;

  const isAssigned = await hasActiveFindingAssignmentForExternalMember(
    externalMember.externalOrgMemberId,
    id,
  );
  if (!isAssigned) {
    throw new AppError('Action not found', 404);
  }

  const result = await prisma.action.findFirst({
    where: { id, orgAccountId: externalMember.organizationId },
    include: {
      ...MESSAGES_INCLUDE,
      site: { select: { name: true, id: true } },
      ...RESPONSIBLE_INCLUDE,
    },
  });
  if (!result) throw new AppError('Action not found', 404);
  return shapeResponsibleAssignees(result);
};

/**
 * Slice 5: external-member counterpart to update_action_into_db — same
 * limited field set, gated by assertCanWriteToActionForExternalMember
 * instead of assertCanWriteToAction (no CallerOrgContext to check ADMIN/
 * LEAD_AUDITOR against here; an external Light User's only possible
 * authority over an Action is a live FindingAssignment).
 */
const update_action_for_external_member = async (req: Request) => {
  const externalMember = req.externalMember as ExternalCallerContext;
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.action.findFirst({
    where: { id, orgAccountId: externalMember.organizationId },
  });
  if (!existing) throw new AppError('Action not found', 404);
  await assertCanWriteToActionForExternalMember(externalMember.externalOrgMemberId, {
    id: existing.id,
  });
  // assignBy deliberately not accepted here — an external Light User can
  // update the finding they were sub-assigned, not reassign who else is
  // responsible for it. Still included on the read-back below so the
  // response shape matches IAction the same as every other endpoint that
  // returns an Action.
  const result = await prisma.action.update({
    where: { id },
    data: {
      ...(req.body.actionTitle !== undefined && { actionTitle: req.body.actionTitle }),
      ...(req.body.actionDisc !== undefined && { actionDisc: req.body.actionDisc }),
      ...(req.body.priority !== undefined && { priority: req.body.priority }),
      ...(req.body.dueDate !== undefined && { dueDate: req.body.dueDate }),
      ...(req.body.status !== undefined && { status: req.body.status }),
    },
    include: { ...RESPONSIBLE_INCLUDE },
  });
  return shapeResponsibleAssignees(result);
};

// update specific action messages
const update_action_messages_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.action.findFirst({
    where: { id, orgAccountId: ctx.organizationId },
  });
  if (!existing) throw new AppError('Action not found', 404);
  await assertCanWriteToAction(ctx, { id: existing.id, inspectionId: existing.inspectionId });

  const result = await prisma.action.update({
    where: { id },
    data: {
      ...(req?.body?.message !== undefined && {
        messages: {
          create: {
            senderAccountId: user.accountId,
            message: req?.body?.message,
          },
        },
      }),
    },
    // Returns the updated messages list (not just responsibleAssignees) --
    // this endpoint's whole purpose is adding a message, so the caller
    // needs to see it without a separate refetch. Found by independent
    // review.
    include: { ...MESSAGES_INCLUDE, ...RESPONSIBLE_INCLUDE },
  });
  return shapeResponsibleAssignees(result);
};

export const action_service = {
  get_all_action_from_db,
  get_single_action_from_db,
  create_action_into_db,
  update_action_into_db,
  upload_action_attachment_into_aws,
  delete_action_from_db,
  assign_light_user_to_action,
  unassign_light_user_from_action,
  unassign_external_light_user_from_action,
  approve_finding_assignment,
  reject_finding_assignment,
  get_finding_assignments_for_action,
  get_my_finding_assignments,
  get_my_finding_assignments_external,
  get_single_action_for_external_member,
  update_action_for_external_member,
  update_action_messages_into_db,
};
