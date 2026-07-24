import { z } from 'zod';

// Slice 2 (#55) never creates ExternalOrgMember rows here — that's slice 5 —
// so all four internal OrgRole values are valid targets for an invite. Role
// *enforcement* (who is allowed to invite whom) is slice 3's job; here we
// only validate shape.
const invite_member = z.object({
  email: z.string('Email is required.').email('Must be a valid email address.'),
  role: z.enum(['ADMIN', 'LEAD_AUDITOR', 'LIGHT_USER', 'VIEWER'], {
    message: 'Role must be one of ADMIN, LEAD_AUDITOR, LIGHT_USER, VIEWER.',
  }),
});

// Accept flow covers two cases in one endpoint (see organization.service.ts
// for the full design note):
//   - the invited email already has an Account -> only `password` is needed,
//     it authenticates the existing account.
//   - the invited email has no Account yet -> `password` + `fullName` create
//     one atomically alongside the OrgMember row.
// Both fields are optional at the schema layer; the service decides which
// are required based on whether the account already exists, and throws a
// 400 AppError if the caller didn't supply what that branch needs.
// `password` is intentionally NOT min(8) here: this same field authenticates
// an *existing* account's already-stored password in the existing-account
// branch (organization.service.ts), where a min-length check would reject a
// legitimately correct password for any account created before an 8-char
// minimum existed anywhere in this codebase's history. The 8-char minimum
// only applies to the new-account branch (choosing a new password), so it's
// enforced there in the service instead, where the branch is actually known.
// Found by independent review.
const accept_invitation = z.object({
  token: z.string('Token is required.').min(1, 'Token is required.'),
  password: z.string('Password is required.').min(1, 'Password is required.'),
  // Capped like every other user-supplied display string in this module
  // (see leadAuditorRoleLabel) — this is the one field on this public,
  // unauthenticated endpoint that had no length limit at all. Found by
  // independent review.
  fullName: z.string().min(1).max(255).optional(),
});

// Admin-only member management (offboarding / time-boxing access). At least
// one of the two fields must be present, or the request has nothing to do —
// a bare `{}` body would otherwise silently succeed and no-op.
const update_member = z
  .object({
    status: z
      .enum(['ACTIVE', 'SUSPENDED'], {
        message: 'Status must be either ACTIVE or SUSPENDED.',
      })
      .optional(),
    // Explicit null clears an existing expiry; omitting the field leaves it
    // untouched (see the optional-vs-null distinction in organization.service.ts).
    expiresAt: z.coerce.date('expiresAt must be a valid date.').nullable().optional(),
  })
  .refine((data) => data.status !== undefined || data.expiresAt !== undefined, {
    message: 'At least one of status or expiresAt must be provided.',
  });

// Slice 4 (#55): requireApprovalForSubAssignment toggles whether a Lead
// Auditor's finding sub-assignment needs Admin sign-off before it takes
// effect; leadAuditorRoleLabel is the configurable display name for the
// Lead Auditor role. At least one of the two must be present, matching
// update_member's pattern — a bare `{}` body would otherwise silently
// succeed and no-op.
const update_settings = z
  .object({
    requireApprovalForSubAssignment: z.boolean().optional(),
    leadAuditorRoleLabel: z.string().min(1).max(100).optional(),
  })
  .refine(
    (data) =>
      data.requireApprovalForSubAssignment !== undefined || data.leadAuditorRoleLabel !== undefined,
    {
      message:
        'At least one of requireApprovalForSubAssignment or leadAuditorRoleLabel must be provided.',
    },
  );

// Slice 5 (#55): role is optional and, if present, must be LIGHT_USER — see
// invite_external_member_into_db for why VIEWER is rejected here rather than
// silently accepted.
const invite_external_member = z.object({
  // Capped for the same reason as fullName/leadAuditorRoleLabel below — this
  // value also lands in ExternalOrgMember's (organizationId, email) unique
  // index. Found by independent review.
  email: z.string('Email is required.').email('Must be a valid email address.').max(255),
  fullName: z.string().min(1).max(255).optional(),
  role: z.enum(['LIGHT_USER', 'VIEWER']).optional(),
});

const update_external_member = z
  .object({
    isActive: z.boolean().optional(),
    expiresAt: z.coerce.date('expiresAt must be a valid date.').nullable().optional(),
  })
  .refine((data) => data.isActive !== undefined || data.expiresAt !== undefined, {
    message: 'At least one of isActive or expiresAt must be provided.',
  });

// Admin-provisioned tenant creation (#96). The manual (non-AI) fallback and
// the AI onboarding commit both create the same shape of org, so they share
// the same core fields. Password minimum matches the new-account branch of
// account creation elsewhere in this codebase.
const create_organization = z.object({
  organizationName: z.string('Organization name is required.').min(1).max(255),
  email: z.string('Email is required.').email('Must be a valid email address.').max(255),
  password: z.string('Password is required.').min(8, 'Password must be at least 8 characters.'),
  sector: z.string().max(255).nullish(),
  country: z.string().max(255).nullish(),
});

export const organization_validations = {
  invite_member,
  accept_invitation,
  update_member,
  update_settings,
  invite_external_member,
  update_external_member,
  create_organization,
};
