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
// Evidence attachment URLs. A writer must not be able to persist an arbitrary
// string here — CompliancePage.tsx renders each entry as a clickable
// <a href={url}> shown to every org member, so an unvalidated value is a
// stored link-injection vector (`javascript:` / `data:` / attacker-hosted).
// The real upload path (upload_compliance_attachment_into_aws → Cloudinary)
// returns an https `secure_url`, so restrict to a well-formed URL whose scheme
// is exactly https and reject everything else.
const httpsUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'Attachment URL must use the https scheme.' },
  );

const create_compliance = z.object({
  title: z.string(),
  description: z.string().optional(),
  domain: z.string(),
  // The site <select> submits "" when "Org-wide (no site)" is chosen. On
  // CREATE, persist that as an unset column (org-wide obligation), not an
  // empty string that would fail the Site FK: normalize "" -> undefined before
  // the optional string check. (UPDATE needs different handling — see
  // update_compliance below.)
  site_id: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().optional()),
  status: z.string(),
  owner: z.string().optional(),
  due_date: optionalDate,
  attachments: z.array(httpsUrl).optional(),
  ai_generated: z.boolean().optional(),
  is_edited: z.boolean().optional(),
});

// On UPDATE, `site_id` needs three-way handling that create's "'' -> undefined"
// normalization can't express:
//   - undefined (field absent from the PATCH body) -> leave the column
//     unchanged (Prisma treats `undefined` as "don't touch").
//   - null or "" (the frontend edit form sends null when the user picks
//     "Org-wide") -> clear the scope, i.e. write NULL.
//   - a real string -> re-scope to that site.
// The create schema coerced null/"" to undefined, which made "leave unchanged"
// and "make org-wide" indistinguishable — so a site-scoped obligation could
// never be reset to org-wide (the PATCH reported success but silently kept the
// old site). Override site_id here so an explicit null/"" reaches Prisma as
// null. See aexa-server#204.
const update_compliance = create_compliance.partial().extend({
  site_id: z.preprocess((v) => (v === '' ? null : v), z.string().nullable().optional()),
});

export const compliance_validations = {
  create_compliance,
  update_compliance,
};
