import { z } from 'zod';

// #97: Three Lines of Defense classification. Not required on create —
// AuditEngagement has a sensible schema-level default (THIRD, see
// audit.prisma). Reassignment is further gated in audit.service.ts (only
// ADMIN/LEAD_AUDITOR via assertCanWriteOrgResource, which already applies to
// the whole payload).
const LINE_OF_DEFENSE_ENUM = z.enum(['FIRST', 'SECOND', 'THIRD']);

// The frontend date inputs submit "" (empty string) when left blank, not
// null/undefined. z.coerce.date() would turn "" into an Invalid Date and
// reject the whole payload, so normalize an empty string to undefined before
// coercion. Wrapped as a reusable optional date field. Used on CREATE, where
// "" and null both simply mean "no date" — Prisma stores NULL for the omitted
// value since the column is nullable.
const optionalDate = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.coerce.date().optional(),
);

// UPDATE-only date field. On a PATCH we must distinguish three cases the CREATE
// preprocessor above collapses together:
//   - key absent / undefined -> "leave unchanged" (undefined; Prisma ignores it)
//   - null or ""             -> "clear this date"  (null; Prisma writes NULL)
//   - a value                -> coerce + set
// The frontend (AuditPage.tsx handleSave) deliberately sends `closed_at: null`
// / `started_at: null` to clear a previously-set date; the CREATE-style
// preprocessor turned that null into undefined ("leave unchanged"), so the
// clear silently never persisted. No other module needs this distinction
// today, so this is a new pattern established narrowly here, scoped only to the
// audit update date fields.
const updatableDate = z.preprocess((v) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return v;
}, z.coerce.date().nullable().optional());

// Required fields mirror the frontend AuditPage form's own validation gate
// (handleSave bails unless `title` is present; `status` always has a value
// from the select, defaulting to "planned"). `ref` and `title` are required
// with `.min(1)`: `ref` maps to a NOT NULL column in prisma/schema/audit.prisma
// (`ref String`, no default), so accepting it as optional let a direct API call
// omitting it pass Zod and then hit a Prisma NOT NULL violation — an opaque 500
// instead of a clean 400; `title` with no `.min(1)` allowed empty-titled rows.
// Matches how risk.validation.ts guards its own required string fields (`name`,
// `category`). Everything else is optional — `scope`, `lead_auditor`, dates,
// counts and linked risk ids can all be blank on create. `status` is kept a free
// string (not a zod enum) to match the loose-typing convention Risk.status uses
// and the arbitrary values the frontend already sends.
const create_audit = z.object({
  ref: z.string().min(1, 'Ref is required'),
  title: z.string().min(1, 'Title is required'),
  scope: z.string().optional(),
  status: z.string(),
  lead_auditor: z.string().optional(),
  priority_score: z.number().int().optional(),
  findings_count: z.number().int().optional(),
  started_at: optionalDate,
  closed_at: optionalDate,
  ai_generated: z.boolean().optional(),
  is_edited: z.boolean().optional(),
  // aexa-frontend#165: linked risks are now real Risk record ids (a
  // many-to-many relation), not free-text tags. Each id is validated to belong
  // to the caller's own org in the service layer before any link row is
  // written. On update, omitting the field leaves existing links untouched; an
  // explicit array (including []) replaces the whole link set.
  riskIds: z.array(z.string()).optional(),
  report_url: z.string().optional(),
  line_of_defense: LINE_OF_DEFENSE_ENUM.optional(),
});

// Every field is optional on update (PATCH). The date fields specifically use
// `updatableDate` (not `optionalDate`) so a null can be sent to clear a date —
// see the comment on `updatableDate`.
const update_audit = create_audit.partial().extend({
  started_at: updatableDate,
  closed_at: updatableDate,
});

export const audit_validations = {
  create_audit,
  update_audit,
};
