import z from 'zod';

// Shared strength rule for every field that sets a *new* password (signup,
// change-password's newPassword, reset-password). Deliberately NOT applied
// to a password field that only authenticates an already-stored password
// (sing_in.password, change_password.oldPassword) — those must keep
// accepting whatever a legitimately correct password already is, including
// ones created before this rule existed. Mirrors the same reasoning already
// documented for organization_validations.accept_invitation.
//
// Bar chosen per issue #113: length-based minimum (NIST guidance favors
// length over composition rules) plus a minimal letter+number requirement,
// rather than mandatory special characters/mixed case, which tend to
// produce weaker, more annoying passwords in practice. This is a
// product/security-policy choice — adjust here if the repo owner wants
// something stricter or looser.
export const passwordSchema = z
  .string('Password is required.')
  .min(10, 'Password must be at least 10 characters.')
  .regex(/[A-Za-z]/, 'Password must contain at least one letter.')
  .regex(/[0-9]/, 'Password must contain at least one number.');

// Shared email format rule for every field that accepts an email address in
// this module (signup, sign-in, verify-otp, resend-otp). Matches the
// .email() pattern already used in organization.validation.ts and
// external-auth.validation.ts, so an invalid-format email is rejected here
// too instead of only being caught downstream. See issue #121.
export const emailSchema = z
  .string('Email is required.')
  .email('Must be a valid email address.')
  .max(255);

const sign_up = z.object({
  email: emailSchema,
  password: passwordSchema,
  organizationName: z.string('Full name is required.'),
});

const sing_in = z.object({
  email: emailSchema,
  password: z.string('Password is required.'),
});

const change_password = z.object({
  oldPassword: z.string('Old Password is required'),
  newPassword: passwordSchema,
});

const verify_otp = z.object({
  email: emailSchema,
  otp: z.string('OTP is required'),
});
const verify_link = z.object({
  token: z.string('Token is required '),
});
const resend_otp = z.object({
  email: emailSchema,
});
const reset_pass = z.object({
  token: z.string('Token is required'),
  newPass: passwordSchema,
});
export const account_validation = {
  sign_up,
  sing_in,
  change_password,
  verify_otp,
  resend_otp,
  verify_link,
  reset_pass,
};
