import { z } from 'zod';

// The frontend date inputs submit "" (empty string) when left blank, not
// null/undefined. z.coerce.date() would turn "" into an Invalid Date and
// reject the whole payload, so normalize an empty string to undefined before
// coercion. Wrapped as a reusable optional/nullable date field.
const optionalDate = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.coerce.date().optional(),
);

// Required fields mirror the frontend AuditPage form's own validation gate
// (handleSave bails unless `title` is present; `status` always has a value
// from the select, defaulting to "planned"). Everything else is optional —
// `ref`, `scope`, `lead_auditor`, dates, counts and linked refs can all be
// blank on create. `status` is kept a free string (not a zod enum) to match
// the loose-typing convention Risk.status uses and the arbitrary values the
// frontend already sends ("planned", "in_progress", "completed", ...).
const create_audit = z.object({
  ref: z.string().optional(),
  title: z.string(),
  scope: z.string().optional(),
  status: z.string(),
  lead_auditor: z.string().optional(),
  priority_score: z.number().int().optional(),
  findings_count: z.number().int().optional(),
  started_at: optionalDate,
  closed_at: optionalDate,
  ai_generated: z.boolean().optional(),
  is_edited: z.boolean().optional(),
  linked_risk_refs: z.array(z.string()).optional(),
  report_url: z.string().optional(),
});

const update_audit = create_audit.partial();

export const audit_validations = {
  create_audit,
  update_audit,
};
