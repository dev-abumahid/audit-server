import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from './app_error.js';

/**
 * Resolved view of "who is calling and what can they see" for slice 3 of
 * issue #55 (role-based org scoping).
 *
 * `organizationId` is a bit of a misnomer kept for readability at the call
 * site — it does NOT hold `Organization.id`. It holds the Account id that
 * every existing domain table (Inspection, Action, Template, ...) already
 * filters by via `orgAccountId` / `org_account_id` (see CLAUDE.md's org
 * scoping table). That value is `Organization.anchorAccountId`: the account
 * that "owns" the org's data today. Every member of the org — whatever
 * their own accountId is — must filter domain-table reads by the org's
 * anchorAccountId, not by their own accountId, or invited (non-anchor)
 * members would see nothing.
 */
export type CallerOrgContext = {
  organizationId: string;
  role: 'ADMIN' | 'LEAD_AUDITOR' | 'LIGHT_USER' | 'VIEWER';
  orgMemberId: string | null;
};

/**
 * Resolves the caller's org context from their accountId.
 *
 * Backward-compat fallback: a caller with no OrgMember row at all (either
 * the pre-slice-1-backfill edge case, or the backfill hasn't run yet in
 * this environment) is treated as ADMIN of themselves, using their own
 * accountId as the anchor. This mirrors the "no membership yet" fallback
 * pattern used by requireCallerIsOrgAdmin in organization.service.ts (that
 * function 403s instead of falling back, because invite-management is a
 * privileged action with no sane default — but the underlying "no
 * membership row found" case is the same one being defended against here).
 * It's also self-consistent with the pre-slice-3 baseline: every domain
 * table query used to filter by `user.accountId` directly, which is
 * exactly what this fallback reproduces for accounts that aren't part of
 * a multi-member org yet.
 */
/**
 * True if an OrgMember row represents a caller who should still be let in:
 * ACTIVE status and not past their (optional) time-boxed expiresAt. Shared
 * by resolveCallerOrgContext and requireCallerIsOrgAdmin (organization.service.ts)
 * so the two org-role gates in this codebase can't silently drift apart —
 * that already happened once (requireCallerIsOrgAdmin shipped without this
 * check, fixed in a follow-up once independent review caught it) precisely
 * because the logic was duplicated instead of shared.
 */
export const isMembershipActive = (membership: { status: string; expiresAt: Date | null }) => {
  const isExpired = !!membership.expiresAt && membership.expiresAt.getTime() < Date.now();
  return membership.status === 'ACTIVE' && !isExpired;
};

/**
 * Looks up an account's OrgMember row and enforces isMembershipActive,
 * returning null only for "no membership row at all" (not a member of any
 * org yet). Shared by resolveCallerOrgContext and organization.service.ts's
 * requireCallerIsOrgAdmin so there's exactly one place doing this lookup —
 * see isMembershipActive's docstring for why that matters (the two call
 * sites already drifted apart once when each had its own copy of this
 * query).
 */
export const findActiveMembership = async (accountId: string) => {
  const membership = await prisma.orgMember.findUnique({ where: { accountId } });
  if (!membership) return null;

  // A membership row existing is not the same as it being live: SUSPENDED
  // (explicit offboarding) and an expired expiresAt (time-boxed access,
  // e.g. an external Viewer's engagement window) must both revoke access
  // even though the row — and the caller's JWT — are both still present.
  // This is a hard deny, not the "no membership at all" case above: falling
  // back to ADMIN-of-self there would hand a suspended/expired member of a
  // real org full admin rights over their own now-disconnected slice, which
  // is worse than denying them outright.
  if (!isMembershipActive(membership)) {
    throw new AppError('Your access to this organization is no longer active.', 403);
  }
  return membership;
};

export const resolveCallerOrgContext = async (accountId: string): Promise<CallerOrgContext> => {
  const membership = await findActiveMembership(accountId);
  if (!membership) {
    return { organizationId: accountId, role: 'ADMIN', orgMemberId: null };
  }

  const organization = await prisma.organization.findUnique({
    where: { id: membership.organizationId },
  });
  // Defensive: the FK guarantees this row exists in practice. If it's ever
  // missing (data corruption / racing delete), fail closed rather than
  // falling back to ADMIN-of-self — that fallback exists for the "no
  // membership row at all" case above, where there's genuinely nothing to
  // scope by; here a real (non-ADMIN) membership exists, so silently
  // upgrading e.g. a VIEWER to full ADMIN would be a privilege escalation,
  // not a reasonable default. Found by independent review.
  if (!organization) {
    throw new AppError('Your organization could not be found.', 403);
  }

  return {
    organizationId: organization.anchorAccountId,
    role: membership.role,
    orgMemberId: membership.id,
  };
};

/**
 * Every assignment endpoint (InspectionAssignment, FindingAssignment) needs
 * the caller's real Organization.id (not ctx.organizationId, which is the
 * anchor Account.id used by the legacy orgAccountId columns) to scope which
 * OrgMember rows they're allowed to assign. Requires ctx.orgMemberId to be
 * set — an ADMIN with no OrgMember row at all (the backward-compat fallback
 * for pre-multi-tenant accounts) has no real Organization to assign anyone
 * into. Originally lived only in inspection.service.ts; moved here once
 * action.service.ts needed the identical helper for slice 4's finding
 * sub-assignment, rather than let a second copy start drifting.
 */
export const requireCallerOrganizationId = async (ctx: CallerOrgContext): Promise<string> => {
  if (!ctx.orgMemberId) {
    throw new AppError('You are not part of a multi-member organization.', 403);
  }
  const membership = await prisma.orgMember.findUnique({ where: { id: ctx.orgMemberId } });
  if (!membership) {
    throw new AppError('You are not part of a multi-member organization.', 403);
  }
  return membership.organizationId;
};

const getAssignedInspectionIds = async (orgMemberId: string | null): Promise<string[]> => {
  if (!orgMemberId) return [];
  const rows = await prisma.inspectionAssignment.findMany({
    // revokedAt: null — a revoked assignment must stop counting for scope
    // immediately, same as the row being deleted did before assignments
    // became soft-revocable.
    where: { orgMemberId, revokedAt: null },
    select: { inspectionId: true },
  });
  return rows.map((row) => row.inspectionId);
};

type InspectionAssignmentState = { activeIds: string[]; everAssigned: boolean };

/**
 * Distinguishes "this Viewer was never assigned anything" (the org-wide
 * visibility fallback is intentional — board-member/compliance-officer
 * case) from "this Viewer WAS assigned, and every assignment was later
 * revoked" (an admin cutting off their access). Both cases have zero
 * *active* assignments, but only the first should fall back to org-wide —
 * without this distinction, revoking a Viewer's last assignment would
 * silently grant them broader access than they had before, the opposite of
 * what an admin doing the revoking intends. Fetches every row (active or
 * revoked) once and derives both facts locally, rather than a separate
 * findMany + count round-trip. Found by independent review.
 */
const getInspectionAssignmentState = async (
  orgMemberId: string | null,
): Promise<InspectionAssignmentState> => {
  if (!orgMemberId) return { activeIds: [], everAssigned: false };
  const rows = await prisma.inspectionAssignment.findMany({
    where: { orgMemberId },
    select: { inspectionId: true, revokedAt: true },
  });
  return {
    activeIds: rows.filter((row) => row.revokedAt === null).map((row) => row.inspectionId),
    everAssigned: rows.length > 0,
  };
};

/**
 * Shared Viewer fallback rule for both applyInspectionScope and
 * applyActionScope: scope to active assignments if any exist, deny (scope to
 * nothing) if assignments existed but were all revoked, or fall back to
 * org-wide if never assigned. Kept in one place so the never-assigned-vs-
 * revoked distinction can't drift between the two scopes.
 */
const applyViewerAssignmentScope = (
  whereCondition: Record<string, unknown>,
  field: string,
  state: InspectionAssignmentState,
): Record<string, unknown> => {
  if (state.activeIds.length > 0) return restrictFieldToIds(whereCondition, field, state.activeIds);
  if (state.everAssigned) return restrictFieldToIds(whereCondition, field, []);
  return whereCondition;
};

/**
 * Slice 4: the real scoping mechanism for internal LIGHT_USER members. A
 * FindingAssignment only grants access once it's ACTIVE (either created
 * that way, or approved out of PENDING_APPROVAL by an Admin — see
 * action.service.ts) and not revoked. A still-pending or rejected
 * assignment grants nothing, by design: the whole point of the approval
 * toggle is that access doesn't take effect until an Admin signs off.
 */
const getAssignedActionIds = async (orgMemberId: string | null): Promise<string[]> => {
  if (!orgMemberId) return [];
  const rows = await prisma.findingAssignment.findMany({
    where: { orgMemberId, status: 'ACTIVE', revokedAt: null },
    select: { actionId: true },
  });
  return rows.map((row) => row.actionId);
};

/**
 * Restricts `whereCondition[field]` to `ids`, intersecting with whatever
 * filter is already present instead of blindly overwriting it (e.g.
 * get_single_*_from_db already filters by a specific id — we narrow that
 * down to "that id, if it's in the assigned set" rather than discarding
 * the existing filter).
 */
const restrictFieldToIds = (
  whereCondition: Record<string, unknown>,
  field: string,
  ids: string[],
): Record<string, unknown> => {
  const existing = whereCondition[field];

  if (existing === undefined) {
    return { ...whereCondition, [field]: { in: ids } };
  }

  if (typeof existing === 'string') {
    return { ...whereCondition, [field]: ids.includes(existing) ? existing : { in: [] } };
  }

  if (
    existing &&
    typeof existing === 'object' &&
    Array.isArray((existing as { in?: unknown[] }).in)
  ) {
    const existingIds = (existing as { in: string[] }).in;
    return { ...whereCondition, [field]: { in: existingIds.filter((id) => ids.includes(id)) } };
  }

  // Unrecognized filter shape (e.g. `not`, `notIn`). Neither current call
  // site (Inspection.id, Action.inspectionId) ever passes anything but
  // undefined/string/{in:[...]}, so this is deliberately unhandled rather
  // than merged via a speculative, untested AND-clause construction that
  // could silently clobber a whereCondition.AND a future caller sets for
  // an unrelated filter. Fail loudly so a real caller with a richer filter
  // gets a clear error instead of a quietly-wrong query.
  throw new AppError(
    `org_scope: unsupported existing filter shape on "${field}" — restrictFieldToIds only handles undefined, a plain id string, or {in: [...]}.`,
    500,
  );
};

/**
 * Applies Lead Auditor / Viewer inspection scoping to an Inspection
 * where-condition. See CallerOrgContext for role semantics.
 */
export const applyInspectionScope = async (
  whereCondition: Record<string, unknown>,
  ctx: CallerOrgContext,
): Promise<Record<string, unknown>> => {
  if (ctx.role === 'ADMIN') return whereCondition;

  if (ctx.role === 'LEAD_AUDITOR') {
    const ids = await getAssignedInspectionIds(ctx.orgMemberId);
    return restrictFieldToIds(whereCondition, 'id', ids);
  }

  if (ctx.role === 'VIEWER') {
    // Zero *active* assignments falls back to org-wide visibility only if
    // this Viewer was NEVER assigned anything (board-member/compliance-
    // officer case). If they had assignments that were all later revoked,
    // that's an admin cutting off their access, not a request for org-wide
    // visibility — see getInspectionAssignmentState's docstring.
    const state = await getInspectionAssignmentState(ctx.orgMemberId);
    return applyViewerAssignmentScope(whereCondition, 'id', state);
  }

  // LIGHT_USER (real scoping mechanism is slice 4's FindingAssignment, not
  // built yet) and any unrecognized role: deny by default.
  return restrictFieldToIds(whereCondition, 'id', []);
};

/**
 * Applies Lead Auditor / Viewer / Light User scoping to an Action (finding)
 * where-condition. Lead Auditor and Viewer are scoped transitively via
 * their parent inspection's InspectionAssignment rows (inspection-level
 * access). LIGHT_USER is scoped directly by `id` instead — they never get
 * inspection-level access, only the specific finding(s) they've been
 * sub-assigned via an ACTIVE FindingAssignment (slice 4).
 */
export const applyActionScope = async (
  whereCondition: Record<string, unknown>,
  ctx: CallerOrgContext,
): Promise<Record<string, unknown>> => {
  if (ctx.role === 'ADMIN') return whereCondition;

  if (ctx.role === 'LEAD_AUDITOR') {
    const ids = await getAssignedInspectionIds(ctx.orgMemberId);
    return restrictFieldToIds(whereCondition, 'inspectionId', ids);
  }

  if (ctx.role === 'VIEWER') {
    // Same never-assigned-vs-revoked distinction as applyInspectionScope.
    const state = await getInspectionAssignmentState(ctx.orgMemberId);
    return applyViewerAssignmentScope(whereCondition, 'inspectionId', state);
  }

  if (ctx.role === 'LIGHT_USER') {
    const ids = await getAssignedActionIds(ctx.orgMemberId);
    return restrictFieldToIds(whereCondition, 'id', ids);
  }

  return restrictFieldToIds(whereCondition, 'inspectionId', []);
};

/**
 * Write-side counterpart to applyInspectionScope/applyActionScope. Both
 * Inspection and Action writes are ultimately scoped by "am I allowed to
 * edit this inspection" — an Action's write scope is its parent
 * inspection's write scope, since findings live inside an inspection.
 *
 * ADMIN: always allowed.
 * LEAD_AUDITOR: allowed only if assigned to inspectionId (create/edit
 *   "within scope", per the product spec).
 * VIEWER: never allowed — read + comment/flag only, never edit/assign, by
 *   design. (Comment/flag is a separate, not-yet-built surface — this
 *   function only gates the existing create/update/delete endpoints.)
 * LIGHT_USER: never allowed here — their real write surface is slice 4's
 *   sub-assigned FindingAssignment flow, not this general endpoint.
 */
export const assertCanWriteToInspection = async (
  ctx: CallerOrgContext,
  inspectionId: string,
): Promise<void> => {
  if (ctx.role === 'ADMIN') return;

  if (ctx.role === 'LEAD_AUDITOR') {
    const ids = await getAssignedInspectionIds(ctx.orgMemberId);
    if (ids.includes(inspectionId)) return;
    throw new AppError('You are not assigned to this inspection.', 403);
  }

  throw new AppError('You do not have permission to modify this inspection.', 403);
};

/**
 * Slice 4: write gate for a specific Action (finding), used instead of
 * assertCanWriteToInspection wherever a LIGHT_USER's sub-assigned write
 * access needs to be honored (update_action_into_db, delete_action_from_db)
 * — NOT for creating a new Action, which stays inspection-scoped only
 * (assertCanWriteToInspection): a Light User works within findings they've
 * been sub-assigned to, they don't create new ones.
 *
 * ADMIN: always allowed.
 * LEAD_AUDITOR: allowed if assigned to the action's parent inspection (same
 *   rule as assertCanWriteToInspection).
 * LIGHT_USER: allowed only if they hold an ACTIVE, non-revoked
 *   FindingAssignment for this exact action — a PENDING_APPROVAL or
 *   REJECTED assignment grants nothing.
 * VIEWER: never allowed.
 */
export const assertCanWriteToAction = async (
  ctx: CallerOrgContext,
  action: { id: string; inspectionId: string },
): Promise<void> => {
  if (ctx.role === 'ADMIN') return;

  if (ctx.role === 'LEAD_AUDITOR') {
    const ids = await getAssignedInspectionIds(ctx.orgMemberId);
    if (ids.includes(action.inspectionId)) return;
    throw new AppError('You are not assigned to this inspection.', 403);
  }

  if (ctx.role === 'LIGHT_USER') {
    // Targeted existence check instead of getAssignedActionIds — that
    // helper fetches every live assignment for the member (needed for
    // applyActionScope's listing use case), which is unnecessary work here
    // where only "does a live assignment exist for this one action" is
    // being asked. Found by independent review.
    if (!ctx.orgMemberId) {
      throw new AppError('You are not assigned to this finding.', 403);
    }
    const live = await prisma.findingAssignment.findFirst({
      where: {
        orgMemberId: ctx.orgMemberId,
        actionId: action.id,
        status: 'ACTIVE',
        revokedAt: null,
      },
      select: { id: true },
    });
    if (live) return;
    throw new AppError('You are not assigned to this finding.', 403);
  }

  throw new AppError('You do not have permission to modify this finding.', 403);
};

/**
 * Write gate for org-wide shared resources that aren't owned by a single
 * inspection — Site and Template. Unlike assertCanWriteToInspection, there's
 * no per-inspection assignment to check here (a Site/Template isn't scoped
 * to one inspection), so this is a plain role gate: ADMIN and LEAD_AUDITOR
 * may create/edit/delete; VIEWER (read + comment/flag only, never edit, per
 * assertCanWriteToInspection's own docs) and LIGHT_USER may not. Found by
 * independent review: create/update/delete on these two modules had no role
 * check at all, only org-anchor scoping — any active member of any role
 * could create, edit, or delete the whole org's Sites/Templates.
 */
export const assertCanWriteOrgResource = (ctx: CallerOrgContext): void => {
  if (ctx.role === 'ADMIN' || ctx.role === 'LEAD_AUDITOR') return;
  throw new AppError('You do not have permission to modify this resource.', 403);
};

/**
 * Admin-only gate for privileged organization-wide actions that aren't
 * "write to a resource" so much as "change who can access something" —
 * currently just Template access grant/revoke. Found by independent review:
 * add/remove_template_access_member_into_db had no role check whatsoever, so
 * any active member (including LIGHT_USER) could grant or revoke *other
 * users'* template access — a privilege-escalation path, not just an
 * over-broad write.
 */
export const assertIsOrgAdmin = (ctx: CallerOrgContext): void => {
  if (ctx.role === 'ADMIN') return;
  throw new AppError('Only organization admins can perform this action.', 403);
};

/**
 * Writes an OrgAuditLog row for any org-lifecycle event. Fire-and-forget
 * from the caller's perspective (awaited, but never allowed to fail the
 * request it's logging) — an audit-log write failing shouldn't block the
 * actual invite/status-change/assignment it's recording, or every
 * legitimate action becomes hostage to the audit table being healthy.
 *
 * Originally two near-identical copies of this existed (organization.service.ts's
 * recordAuditEvent and action.service.ts's recordFindingAuditEvent) — merged
 * here once slice 4 needed the same pattern a second time, same reasoning as
 * requireCallerOrganizationId above: two independently-maintained copies is
 * exactly how the isMembershipActive predicate already drifted out of sync
 * once before independent review caught it.
 */
export const recordOrgAuditEvent = async (entry: {
  organizationId: string;
  action:
    | 'MEMBER_INVITED'
    | 'MEMBER_INVITE_RESENT'
    | 'MEMBER_INVITE_ACCEPTED'
    | 'MEMBER_STATUS_CHANGED'
    | 'MEMBER_EXPIRY_CHANGED'
    | 'MEMBER_REMOVED'
    | 'INSPECTION_ASSIGNMENT_CREATED'
    | 'INSPECTION_ASSIGNMENT_REVOKED'
    | 'FINDING_ASSIGNMENT_CREATED'
    | 'FINDING_ASSIGNMENT_APPROVED'
    | 'FINDING_ASSIGNMENT_REJECTED'
    | 'FINDING_ASSIGNMENT_REVOKED'
    | 'ORG_SETTINGS_CHANGED';
  actorAccountId?: string | null;
  subjectOrgMemberId?: string | null;
  subjectEmail?: string | null;
  metadata?: Record<string, unknown>;
}) => {
  try {
    await prisma.orgAuditLog.create({
      data: { ...entry, metadata: entry.metadata as Prisma.InputJsonValue },
    });
  } catch (err) {
    logger.error({ err, entry }, 'Failed to write OrgAuditLog entry');
  }
};
