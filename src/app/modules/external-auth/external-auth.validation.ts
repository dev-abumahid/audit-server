import { z } from 'zod';

// organizationId is Organization.id (not the anchor Account.id) — the value
// embedded in the invite link an admin sends an external member, see
// organization.service.ts's invite_external_member_into_db.
//
// email is capped like every other user-supplied string that lands in a DB
// unique index in this codebase (see organization.validation.ts's fullName/
// leadAuditorRoleLabel comment) — this endpoint is public and unauthenticated,
// and an oversized value here reaches the (organizationId, email) partial
// unique index on ExternalOrgMember, where Postgres's btree index-entry size
// limit can turn a bad-input request into a raw 500 instead of a clean 400.
// Found by independent review.
const request_code = z.object({
  organizationId: z.string('organizationId is required.').min(1, 'organizationId is required.'),
  email: z.string('Email is required.').email('Must be a valid email address.').max(255),
});

// code is restricted to exactly 6 digits, not just 6 characters — the
// generator (otpGenerator.ts's numericVerificationCodeGenerator) only ever
// produces numeric codes, so a non-numeric guess can never match and would
// just burn a slot in externalCodeVerifyLimiter's budget for free before
// even reaching the DB/bcrypt path. Found by independent review.
const verify_code = z.object({
  organizationId: z.string('organizationId is required.').min(1, 'organizationId is required.'),
  email: z.string('Email is required.').email('Must be a valid email address.').max(255),
  code: z.string('Code is required.').regex(/^\d{6}$/, 'Code must be 6 digits.'),
});

export const external_auth_validations = {
  request_code,
  verify_code,
};
