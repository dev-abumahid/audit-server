import { z } from 'zod';
import { CallerOrgContext, assertCanReassignLineOfDefense } from './org_scope.js';

export type LineOfDefenseValue = 'FIRST' | 'SECOND' | 'THIRD' | 'GOVERNING_BODY';

// Shared request-body schema for every entity's POST .../:id/line-reviews
// endpoint (risk, action, kri, compliance, audit) -- identical shape across
// all 5, so it lives here once rather than 5 near-duplicate copies across
// each module's own *.validation.ts.
export const recordLineReviewBody = z.object({
  line: z.enum(['FIRST', 'SECOND', 'THIRD', 'GOVERNING_BODY']),
  notes: z.string().optional(),
});

// THIRD line is internal audit's own independent check; every other line
// (FIRST/SECOND/GOVERNING_BODY) is a management-line judgment call.
//
// Deliberately keyed by the VALUE of `line` being recorded, not by entity
// type the way assertCanReassignLineOfDefense's callers are (each of THOSE
// hardcodes a fixed ownerRole per entity -- e.g. every Risk reassignment
// requires MANAGEMENT_LINE/ADMIN regardless of which line it's being
// reassigned TO). This is intentionally the opposite axis: recording a
// review is "self-certifying independence" -- only LEAD_AUDITOR may vouch
// that THIRD line reviewed something, on ANY entity, including a Risk
// (whose OWNERSHIP reassignment requires ADMIN and blocks LEAD_AUDITOR
// entirely). The two checks reuse the same underlying role-gate helper and
// the same third-line-independence principle, but are NOT meant to line up
// value-for-value -- don't "fix" one to match the other's keying.
const ownerRoleForLine = (line: LineOfDefenseValue) =>
  line === 'THIRD' ? 'AUDIT_LINE' : 'MANAGEMENT_LINE';

export const assertCanRecordLineReview = (ctx: CallerOrgContext, line: LineOfDefenseValue): void =>
  assertCanReassignLineOfDefense(ctx, ownerRoleForLine(line));

// Deliberately typed loosely (args: any) rather than structurally against
// Record<string, unknown>: Prisma's 5 generated *LineReview delegates each
// have a distinct, strict `data`/`where` input type (RiskLineReviewCreateInput
// vs ActionLineReviewCreateInput, etc.), and none of those structurally
// satisfies a shared Record-shaped signature even though the fields are
// identical at runtime. This helper's whole purpose is genericity across
// those 5 delegates -- each call site below is itself fully typed (the
// entity-specific service functions know their own field names), so the
// looseness is contained to this one internal shim, not exposed to callers.
type LineReviewDelegate = {
  updateMany: (args: { where: any; data: any }) => Promise<unknown>;
  create: (args: { data: any }) => Promise<unknown>;
  findMany: (args: { where: any; orderBy?: any }) => Promise<unknown>;
};

/**
 * Records a review for one line-of-defense on one entity, superseding
 * (invalidating) any prior live review for that same line -- mirrors
 * RiskApproval's soft-supersede shape, just triggered by a fresh review
 * instead of an edit to the reviewed item. Generic across the 5
 * structurally-identical *LineReview tables (see
 * line_of_defense_review.prisma) -- each caller passes its own Prisma
 * delegate and FK field name rather than this file hardcoding 5
 * near-duplicate copies of the same supersede/create sequence, matching
 * this codebase's "real per-entity relation, generic helper code" split
 * (real tables per entity, shared logic where the shape is identical).
 */
export async function recordLineReview(
  delegate: LineReviewDelegate,
  fkField: string,
  entityId: string,
  reviewedById: string,
  line: LineOfDefenseValue,
  notes: string | undefined,
): Promise<void> {
  await delegate.updateMany({
    where: { [fkField]: entityId, line, invalidatedAt: null },
    data: { invalidatedAt: new Date() },
  });
  await delegate.create({
    data: { [fkField]: entityId, line, reviewedById, notes: notes ?? null },
  });
}

/**
 * Invalidates every live review on an entity -- call this from each
 * entity's own update_*_into_db whenever a substantive field changes, same
 * "the reviewed version is now stale" reasoning as RiskApproval's
 * invalidate-on-edit. A review that's still live after an edit would claim
 * a line reviewed content that no longer exists.
 */
export async function invalidateLiveLineReviews(
  delegate: LineReviewDelegate,
  fkField: string,
  entityId: string,
): Promise<void> {
  await delegate.updateMany({
    where: { [fkField]: entityId, invalidatedAt: null },
    data: { invalidatedAt: new Date() },
  });
}
