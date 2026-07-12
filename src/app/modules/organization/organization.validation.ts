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
const accept_invitation = z.object({
  token: z.string('Token is required.').min(1, 'Token is required.'),
  password: z.string('Password is required.').min(8, 'Password must be at least 8 characters.'),
  fullName: z.string().min(1).optional(),
});

export const organization_validations = {
  invite_member,
  accept_invitation,
};
