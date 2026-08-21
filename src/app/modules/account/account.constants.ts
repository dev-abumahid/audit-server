import { Prisma } from '@prisma/client';

/**
 * The set of Account columns that are safe to let leave the process boundary
 * (HTTP responses, req.user, anything that could eventually get
 * res.json()'d or serialized). Deliberately excludes `password`, `lastOtp`,
 * and `lastOtpSendingTime` — the sensitive/internal columns on Account.
 *
 * Use this wherever an Account row is fetched for a purpose that ends in
 * exposing it (directly or via req.user) rather than hand-rolling a
 * `select`/pick list per call site — see #167. Originates from the `select`
 * added to `create_account_into_db` for #165 (the first place this pattern
 * was needed, when an unselected `tx.account.create` leaked the bcrypt hash
 * into the sign-up response).
 *
 * `satisfies Prisma.AccountSelect` keeps this in sync with the actual Account
 * model — a field rename/removal in schema.prisma will fail typecheck here
 * instead of silently drifting.
 */
export const SAFE_ACCOUNT_SELECT = {
  id: true,
  email: true,
  role: true,
  provider: true,
  isAccountVerified: true,
  isDeleted: true,
  // Needed so customAccessTokenAndResponse.ts can embed it into the OAuth
  // login's access token, same as every other login path (password-
  // security-hardening audit) -- not a secret, safe to carry on req.user.
  security_stamp: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AccountSelect;
