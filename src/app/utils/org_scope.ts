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
export const resolveCallerOrgContext = async (accountId: string): Promise<CallerOrgContext> => {
  const membership = await prisma.orgMember.findUnique({ where: { accountId } });
  if (!membership) {
    return { organizationId: accountId, role: 'ADMIN', orgMemberId: null };
  }

  const organization = await prisma.organization.findUnique({
    where: { id: membership.organizationId },
  });
  // Defensive: the FK guarantees this row exists in practice. If it's ever
  // missing (data corruption / racing delete), fail safe to the same
  // backward-compat fallback rather than throwing.
  if (!organization) {
    return { organizationId: accountId, role: 'ADMIN', orgMemberId: null };
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
    where: { orgMemberId },
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

  // Unrecognized filter shape (e.g. `not`, `notIn`) — safest is to AND the
  // assignment restriction on top rather than silently drop it.
  return { ...whereCondition, [field]: { in: ids }, AND: [{ [field]: existing }] };
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
