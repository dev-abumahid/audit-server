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
    const ids = await getAssignedInspectionIds(ctx.orgMemberId);
    // Zero assignments = org-wide visibility for Viewer (board-member /
    // compliance-officer case). One or more = scoped, same as Lead Auditor.
    if (ids.length === 0) return whereCondition;
    return restrictFieldToIds(whereCondition, 'id', ids);
  }

  // LIGHT_USER (real scoping mechanism is slice 4's FindingAssignment, not
  // built yet) and any unrecognized role: deny by default.
  return restrictFieldToIds(whereCondition, 'id', []);
};

/**
 * Applies Lead Auditor / Viewer scoping to an Action (finding)
 * where-condition. Actions don't have their own InspectionAssignment rows —
 * they're scoped transitively via their parent inspection's assignments.
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
    const ids = await getAssignedInspectionIds(ctx.orgMemberId);
    if (ids.length === 0) return whereCondition;
    return restrictFieldToIds(whereCondition, 'inspectionId', ids);
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
