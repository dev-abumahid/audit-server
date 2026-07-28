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
/**
 * Shared time-boxed-expiry predicate — used by isMembershipActive and
 * isExternalMembershipActive below, and directly by the two org-member list
 * endpoints (get_org_members_from_db, get_external_members_from_db in
 * organization.service.ts) for their derived `isExpired` display field. Was
 * four independent copies of the identical expression before independent
 * review; kept in one place per this file's own established reasoning (see
 * isMembershipActive's docstring on why duplicated predicates here have
 * already drifted once).
 */
export const hasExpired = (entity: { expiresAt: Date | null }) =>
  !!entity.expiresAt && entity.expiresAt.getTime() < Date.now();

export const isMembershipActive = (membership: { status: string; expiresAt: Date | null }) => {
  return membership.status === 'ACTIVE' && !hasExpired(membership);
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
 * Resolves an arbitrary account's org anchor for a "is this account in the
 * same org as me" check on some OTHER (non-caller) account — e.g. verifying
 * a grant/revoke target belongs to the caller's org. Deliberately does NOT
 * throw for a suspended/expired membership the way resolveCallerOrgContext
 * (via findActiveMembership) does for the *caller* — that throw exists
 * because a caller's own dead membership must hard-deny the whole request
 * with a caller-facing message, but this function is resolving a *target*
 * account: "is that target in my org" and "is that target's own membership
 * currently active" are two independent facts a caller of this function may
 * need to check separately (e.g. revoking a suspended member's leftover
 * access must still succeed even though granting new access to them
 * shouldn't). Returns `isActive: true` under the same ADMIN-of-self fallback
 * resolveCallerOrgContext uses for an account with no OrgMember row at all.
 * Found by independent review — the naive version of this check reused
 * resolveCallerOrgContext directly, which surfaced the caller-oriented 403
 * for a merely-inactive target and made revoking a suspended member's access
 * impossible through the affected endpoint.
 */
export const resolveAccountOrgAnchor = async (
  accountId: string,
): Promise<{ organizationId: string; isActive: boolean }> => {
  const membership = await prisma.orgMember.findUnique({ where: { accountId } });
  if (!membership) {
    return { organizationId: accountId, isActive: true };
  }
  const organization = await prisma.organization.findUnique({
    where: { id: membership.organizationId },
  });
  if (!organization) {
    // Defensive, mirrors resolveCallerOrgContext's fail-closed handling of
    // the same "should never happen" case — a nonexistent org can't match
    // any real caller's organizationId, so this can never wrongly resolve
    // to "same org."
    return { organizationId: `__missing_org__:${membership.organizationId}`, isActive: false };
  }
  return { organizationId: organization.anchorAccountId, isActive: isMembershipActive(membership) };
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
 * Sibling to getAssignedActionIds for callers of applyActionScope targeting
 * a model that's keyed by `inspectionId` rather than Action's own `id` (Note,
 * Recommendation — both 1:1-or-scoped-to an inspection, same as Action
 * itself). A LIGHT_USER has no direct assignment to a Note/Recommendation
 * row; their real grant is the FindingAssignment on an Action, so this joins
 * through Action to resolve which INSPECTIONS their assigned findings live
 * on (issue #280 — the previous code compared a Note/Recommendation's `id`
 * against assigned Action ids, two disjoint UUID namespaces that can never
 * match, so LIGHT_USER always got empty results for these two models).
 * Dedupes because a member commonly holds more than one active
 * FindingAssignment on the same inspection.
 */
const getAssignedActionInspectionIds = async (orgMemberId: string | null): Promise<string[]> => {
  if (!orgMemberId) return [];
  const rows = await prisma.findingAssignment.findMany({
    where: { orgMemberId, status: 'ACTIVE', revokedAt: null },
    select: { action: { select: { inspectionId: true } } },
  });
  return [...new Set(rows.map((row) => row.action.inspectionId))];
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
 * where-condition, OR to any other model that's keyed by the same
 * Action.inspectionId lineage — Note and Recommendation both live 1:1 (Note)
 * or scoped (Recommendation) on an inspection exactly like Action does, and
 * reuse this same scoping rule rather than duplicating it (see
 * note.service.ts, recommendation.service.ts).
 *
 * Lead Auditor and Viewer are scoped transitively via their parent
 * inspection's InspectionAssignment rows (inspection-level access) — this
 * is already correct for any target model, since both branches filter by
 * `inspectionId` regardless of which model owns that column.
 *
 * LIGHT_USER is scoped directly to the finding(s) they've been sub-assigned
 * via an ACTIVE FindingAssignment (slice 4) — but WHICH field that resolves
 * to depends on the target model:
 *   - Action itself (`idField: 'id'`, the default): restrict Action.id to
 *     the assigned action ids directly.
 *   - Note/Recommendation (`idField: 'inspectionId'`): these models have no
 *     `id` comparable to an Action id — comparing them would silently
 *     compare two disjoint UUID namespaces and never match (issue #280).
 *     Instead resolve the INSPECTION ids of the Light User's assigned
 *     actions (getAssignedActionInspectionIds, joining through Action) and
 *     restrict `inspectionId` to that set.
 */
export const applyActionScope = async (
  whereCondition: Record<string, unknown>,
  ctx: CallerOrgContext,
  idField: 'id' | 'inspectionId' = 'id',
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
    if (idField === 'inspectionId') {
      const ids = await getAssignedActionInspectionIds(ctx.orgMemberId);
      return restrictFieldToIds(whereCondition, 'inspectionId', ids);
    }
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
 * Slice 5 (#55): resolved view of "who is calling" for an external (non-
 * Account) org member — the OTP-verified counterpart to CallerOrgContext.
 * Kept as a separate type rather than folding into CallerOrgContext: an
 * external member has no orgMemberId, is never anything but LIGHT_USER today
 * (external VIEWER is deliberately not built yet — see
 * resolveExternalCallerContext), and every existing function that takes a
 * CallerOrgContext assumes an Account-backed caller (resolveCallerOrgContext,
 * requireCallerOrganizationId, the ADMIN/LEAD_AUDITOR/VIEWER branches
 * throughout this file) — reusing that type would mean every one of those
 * call sites needs a runtime check for a caller shape they can never actually
 * receive.
 */
export type ExternalCallerContext = {
  externalOrgMemberId: string;
  // The org's anchor Account.id — same meaning as CallerOrgContext.organizationId,
  // used identically to filter domain tables via orgAccountId/org_account_id.
  organizationId: string;
  // The real Organization.id (Organization.anchorAccountId's owner), needed
  // for OrgAuditLog.organizationId and any future org-scoped lookup that
  // isn't a domain-table orgAccountId filter.

  orgId: string;
  role: 'LIGHT_USER';
};

/**
 * External-member counterpart to isMembershipActive — ExternalOrgMember uses
 * a plain `isActive` boolean instead of OrgMemberStatus, but the same
 * time-boxed-expiry rule applies.
 */
export const isExternalMembershipActive = (member: {
  isActive: boolean;
  expiresAt: Date | null;
}) => {
  return member.isActive && !hasExpired(member);
};

/**
 * Resolves an external member's caller context from the externalOrgMemberId
 * embedded in their verified JWT (see auth_external.ts). Unlike
 * resolveCallerOrgContext, there is no ADMIN-of-self fallback — an external
 * member with no live ExternalOrgMember row has nothing to fall back to, so
 * this always either returns a live context or throws.
 *
 * VIEWER rows are rejected here (not just at invite time in
 * organization.service.ts) as defense in depth: the CEO-approved spec for
 * external Viewers needs inspection-level scoping (InspectionAssignment has
 * no externalOrgMemberId column yet) and a comment/flag system that don't
 * exist yet. An ExternalOrgMember row with role VIEWER can only exist today
 * via direct DB manipulation (invite validation already blocks creating one),
 * so this is a fail-closed backstop, not the primary guard.
 */
export const resolveExternalCallerContext = async (
  externalOrgMemberId: string,
): Promise<ExternalCallerContext> => {
  // Single round-trip via include — this runs on every authenticated
  // external-member request (authExternal re-checks liveness against the DB
  // on every call, not just at login), so the two-query version this
  // replaced (member lookup, then a separate organization lookup) doubled
  // DB latency on that hot path for no reason. Found by independent review.
  const member = await prisma.externalOrgMember.findUnique({
    where: { id: externalOrgMemberId },
    include: { organization: { select: { id: true, anchorAccountId: true } } },
  });
  if (!member) {
    throw new AppError('Your access could not be verified.', 401);
  }
  if (!isExternalMembershipActive(member)) {
    throw new AppError('Your access to this organization is no longer active.', 401);
  }
  if (member.role !== 'LIGHT_USER') {
    throw new AppError('This external member role is not yet supported.', 403);
  }
  // Defensive: the FK guarantees this in practice (same reasoning as
  // resolveCallerOrgContext's identical check).
  if (!member.organization) {
    throw new AppError('Your organization could not be found.', 401);
  }
  return {
    externalOrgMemberId: member.id,
    organizationId: member.organization.anchorAccountId,
    orgId: member.organization.id,
    role: 'LIGHT_USER',
  };
};

/**
 * Targeted single-action existence check — whether one specific
 * (externalOrgMemberId, actionId) pair has a live FindingAssignment, without
 * fetching the member's entire assignment list the way
 * getAssignedActionIdsForExternalMember does. Used by
 * assertCanWriteToActionForExternalMember (write gate) and
 * get_single_action_for_external_member (action.service.ts's read gate) —
 * neither needs the full list, only a yes/no answer for one id. Split out
 * after independent review found the read gate was calling
 * getAssignedActionIdsForExternalMember and checking `.includes(id)`, paying
 * for a full-table fetch to answer a question this targeted query answers
 * directly.
 */
export const hasActiveFindingAssignmentForExternalMember = async (
  externalOrgMemberId: string,
  actionId: string,
): Promise<boolean> => {
  const live = await prisma.findingAssignment.findFirst({
    where: {
      externalOrgMemberId,
      actionId,
      status: 'ACTIVE',
      revokedAt: null,
    },
    select: { id: true },
  });
  return !!live;
};

/**
 * External-member counterpart to assertCanWriteToAction's LIGHT_USER branch
 * — an external Light User may only write to a finding they hold a live
 * (ACTIVE, non-revoked) FindingAssignment for, exactly like an internal one.
 */
export const assertCanWriteToActionForExternalMember = async (
  externalOrgMemberId: string,
  action: { id: string },
): Promise<void> => {
  if (await hasActiveFindingAssignmentForExternalMember(externalOrgMemberId, action.id)) return;
  throw new AppError('You are not assigned to this finding.', 403);
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
 * aexa-frontend#208 — methodology audit finding: the IIA Three Lines Model
 * requires third-line independence (internal audit reports to the
 * governing body, not management; management doesn't get to redefine what
 * internal audit covers). Before this, every model's line_of_defense
 * reassignment rode the same assertCanWriteOrgResource gate as the rest of
 * the payload — ADMIN or LEAD_AUDITOR, no distinction — so a LEAD_AUDITOR
 * (third line) could reclassify a first-line Risk's ownership, and an ADMIN
 * (management) could reclassify a third-line AuditEngagement's own
 * classification. Both are the "one line encroaching on another's
 * ownership" pitfall the 2020 model's principles warn against.
 *
 * Callers apply this as an ADDITIONAL check, only when line_of_defense is
 * actually part of the request — assertCanWriteOrgResource still gates the
 * rest of the payload as before. `ownerRole` names which line genuinely
 * owns the entity being reassigned:
 *   - 'MANAGEMENT_LINE': Risk, Kri, ComplianceObligation (1st/2nd line by
 *     default) — only ADMIN may reassign; LEAD_AUDITOR is blocked.
 *   - 'AUDIT_LINE': AuditEngagement (3rd line by default) — only
 *     LEAD_AUDITOR may reassign; ADMIN is blocked.
 *
 * Action is deliberately NOT gated by this function — it covers both roles
 * by design (no schema default, see action.prisma's own comment), so
 * there's no single "which line owns this" answer to check against; it
 * keeps the plain assertCanWriteOrgResource gate.
 */
export type LineOfDefenseOwnerRole = 'MANAGEMENT_LINE' | 'AUDIT_LINE';

export const assertCanReassignLineOfDefense = (
  ctx: CallerOrgContext,
  ownerRole: LineOfDefenseOwnerRole,
): void => {
  if (ownerRole === 'MANAGEMENT_LINE' && ctx.role === 'ADMIN') return;
  if (ownerRole === 'AUDIT_LINE' && ctx.role === 'LEAD_AUDITOR') return;
  throw new AppError(
    "You do not have permission to reclassify this resource's line of defense.",
    403,
  );
};

/**
 * Verifies a Profile.id belongs to the same org as the caller. Profile has
 * no orgAccountId of its own — "same org" is checked by resolving the
 * target Profile's own account's org anchor and comparing it to the
 * caller's, via resolveAccountOrgAnchor.
 *
 * Originally private to template.service.ts (added for TemplateAccess's
 * body.userId — issue #58, cross-tenant grant/revoke target). Promoted here
 * once inspection.service.ts needed the identical check for
 * create_inspection_into_db's body.inspectorProfileId (issue #279:
 * inspectorProfileId wasn't even in the Zod schema, so it always wrote
 * `undefined`; once added, it needs the same org-ownership guard every other
 * client-supplied foreign id in that function already has), rather than let
 * a second copy of the same Profile-org check start drifting.
 *
 * requireActive is opt-in, not baked into the same-org check itself — an
 * earlier version of this function resolved the target through
 * resolveCallerOrgContext (the caller-facing helper), which throws a 403 for
 * a merely-inactive (suspended/expired) target instead of the uniform 404
 * every other invalid id here produces, AND made it impossible to ever
 * revoke a suspended member's leftover access (the revoke path can't allow
 * that to fail). resolveAccountOrgAnchor resolves the same-org fact without
 * that throw, so the two independent facts — "same org" and "currently
 * active" — can be checked separately per call site. Found by independent
 * review (issue #58).
 */
export const requireTargetProfileInCallerOrg = async (
  profileId: string,
  callerOrganizationId: string,
  { requireActive = false }: { requireActive?: boolean } = {},
) => {
  const targetProfile = await prisma.profile.findUnique({
    where: { id: profileId },
    select: { accountId: true },
  });
  if (!targetProfile) throw new AppError('User not found', 404);
  const target = await resolveAccountOrgAnchor(targetProfile.accountId);
  if (target.organizationId !== callerOrganizationId) {
    throw new AppError('User not found', 404);
  }
  if (requireActive && !target.isActive) {
    throw new AppError("This member's access to the organization is not active.", 400);
  }
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
    | 'ORG_SETTINGS_CHANGED'
    | 'EXTERNAL_MEMBER_INVITED'
    | 'EXTERNAL_MEMBER_REMOVED'
    | 'EXTERNAL_MEMBER_LOGIN_SUCCEEDED'
    | 'RISK_SUBMITTED_FOR_APPROVAL'
    | 'RISK_APPROVAL_APPROVED'
    | 'RISK_APPROVAL_REJECTED'
    | 'RISK_APPROVAL_INVALIDATED'
    | 'ACTION_CLOSURE_SUBMITTED'
    | 'ACTION_CLOSURE_APPROVED'
    | 'ACTION_CLOSURE_REJECTED'
    | 'ACTION_CLOSURE_INVALIDATED';
  actorAccountId?: string | null;
  subjectOrgMemberId?: string | null;
  subjectExternalOrgMemberId?: string | null;
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
