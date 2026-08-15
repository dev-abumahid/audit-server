import { z } from 'zod';

// #97: Three Lines of Defense classification. Not required on create —
// ComplianceObligation has a sensible schema-level default (SECOND, see
// compliance.prisma). Reassignment is gated in compliance.service.ts:
// ADMIN/LEAD_AUDITOR via assertCanWriteOrgResource for the whole payload,
// plus (aexa-frontend#208) a stricter ADMIN-only check specifically when
// line_of_defense itself is being changed — see risk.validation.ts's
// identical comment for the third-line-independence reasoning.
// GOVERNING_BODY (aexa-frontend#208) added as a 4th selectable value.
const LINE_OF_DEFENSE_ENUM = z.enum(['FIRST', 'SECOND', 'THIRD', 'GOVERNING_BODY']);

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
  // aexa-server#243: which specific law/regulation/clause this obligation
  // derives from (ISO 37301 obligations-register basis). Free text, same
  // reasoning as `domain` staying a free string.
  regulation_reference: z.string().optional(),
  // aexa-server#250: declared re-attestation cadence — 'monthly' |
  // 'quarterly' | 'annual', or omitted/null for a non-recurring obligation.
  // Free text (not a zod enum), matching kri.validation.ts's `frequency`
  // precedent — see compliance.service.ts's RECURRENCE_INTERVAL_DAYS for
  // the recognized values. next_review_date is deliberately NOT accepted
  // here: it's derived (see compliance.service.ts), never client-settable.
  recurrence: z.string().optional(),
  ai_generated: z.boolean().optional(),
  is_edited: z.boolean().optional(),
  line_of_defense: LINE_OF_DEFENSE_ENUM.optional(),
});

// On UPDATE, `site_id`/`regulation_reference`/`recurrence` need three-way
// handling that create's "'' -> undefined" normalization can't express:
//   - undefined (field absent from the PATCH body) -> leave the column
//     unchanged (Prisma treats `undefined` as "don't touch").
//   - null or "" (the frontend edit form sends null for a field the user
//     left blank) -> clear it, i.e. write NULL.
//   - a real string -> set/re-scope to that value.
// The create schema coerced null/"" to undefined, which made "leave
// unchanged" and "clear this field" indistinguishable on UPDATE — see
// aexa-server#204 for site_id's own version of this bug (a site-scoped
// obligation could never be reset to org-wide; the PATCH reported success
// but silently kept the old site).
//
// regulation_reference/recurrence had the same gap, but manifesting worse:
// since create_compliance.partial() only widens `z.string().optional()` to
// itself (still non-nullable), ANY edit to an obligation whose
// regulation_reference/recurrence were already unset -- not just an attempt
// to clear a previously-set value -- 400'd outright, because the frontend's
// edit form always resends the current (possibly blank -> null) value for
// every field on every save, not just the fields actually being changed.
// Found live-verifying the edit-history feature (aexa-frontend PR
// feat/compliance-edit-history-ui). The service layer already anticipated
// `null` here (computeNextReviewDate's own signature is
// `string | null | undefined`) — only this schema was blocking it.
const update_compliance = create_compliance.partial().extend({
  site_id: z.preprocess((v) => (v === '' ? null : v), z.string().nullable().optional()),
  regulation_reference: z.preprocess(
    (v) => (v === '' ? null : v),
    z.string().nullable().optional(),
  ),
  recurrence: z.preprocess((v) => (v === '' ? null : v), z.string().nullable().optional()),
});

// aexa-server#250: re-attestation submission — just an optional note, since
// attested_by/attested_at/status_at_attestation are all derived server-side
// from the caller and the obligation's current state, not client input.
const attest_compliance = z.object({
  note: z.string().max(2000).optional(),
});

export const compliance_validations = {
  create_compliance,
  update_compliance,
  attest_compliance,
};
