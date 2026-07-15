import crypto from 'crypto';

// Slice 5 (#55): external member login code. Deliberately separate from
// otpGenerator below — crypto.randomInt (CSPRNG) instead of Math.random(),
// since this code is the sole credential gating access to org data for a
// party with no password/account at all, unlike otpGenerator's role as one
// step in an already-authenticated-by-password signup/reset flow. A short
// numeric code has a small keyspace (1e6), so per-code brute-force
// resistance in this codebase relies on ExternalOrgMemberVerificationCode's
// failedAttempts/lockedUntil columns and the request/verify rate limiters,
// not on unpredictability alone — but starting from a non-CSPRNG source
// would still be a needless weakening of that defense-in-depth.
export const numericVerificationCodeGenerator = (): string => {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
};

export const otpGenerator = (): string => {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const symbols = '@#$%&*!?';

  const allChars = upper + lower + numbers + symbols;

  let otp = '';

  // Ensure at least one character from each set
  otp += upper[Math.floor(Math.random() * upper.length)];
  otp += lower[Math.floor(Math.random() * lower.length)];
  otp += numbers[Math.floor(Math.random() * numbers.length)];
  otp += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill the rest randomly
  for (let i = otp.length; i < 6; i++) {
    otp += allChars[Math.floor(Math.random() * allChars.length)];
  }

  // Shuffle to remove predictable order
  otp = otp
    .split('')
    .sort(() => Math.random() - 0.5)
    .join('');

  return otp;
};
