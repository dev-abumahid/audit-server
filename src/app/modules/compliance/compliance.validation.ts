import { z } from 'zod';

// The frontend date inputs submit "" (empty string) when left blank, not
// null/undefined. z.coerce.date() would turn "" into an Invalid Date and
// reject the whole payload, so normalize an empty string to undefined before
// coercion. Mirrors audit.validation.ts's optionalDate helper.
const optionalDate = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.coerce.date().optional(),
);

// Required fields mirror the frontend CompliancePage form's own validation
// gate (handleSave bails unless `title` is present; `domain` and `status`
// always have a value from their selects). Everything else is optional.
// `status` and `domain` are kept free strings (not zod enums) to match the
// loose-typing convention Risk.status / AuditEngagement.status use and the
// curated-frontend-constant pattern Risk.category uses for its taxonomy.
const create_compliance = z.object({
  title: z.string(),
  description: z.string().optional(),
  domain: z.string(),
  // The site <select> submits "" when "Org-wide (no site)" is chosen. Persist
  // that as null (org-wide obligation), not an empty string that would fail the
  // Site FK. Normalize "" -> undefined before the optional string check.
  site_id: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().optional()),
  status: z.string(),
  owner: z.string().optional(),
  due_date: optionalDate,
  attachments: z.array(z.string()).optional(),
  ai_generated: z.boolean().optional(),
  is_edited: z.boolean().optional(),
});

const update_compliance = create_compliance.partial();

export const compliance_validations = {
  create_compliance,
  update_compliance,
};
