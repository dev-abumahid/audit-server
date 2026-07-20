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

// #109: Math.random() is not cryptographically secure — its output is
// predictable given enough samples, which makes a generated OTP guessable.
// Uses crypto.randomInt (CSPRNG), same as numericVerificationCodeGenerator
// above, for both per-character selection and the final shuffle.
export const otpGenerator = (): string => {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const symbols = '@#$%&*!?';

  const allChars = upper + lower + numbers + symbols;

  const otpChars: string[] = [];

  // Ensure at least one character from each set
  otpChars.push(upper[crypto.randomInt(0, upper.length)]);
  otpChars.push(lower[crypto.randomInt(0, lower.length)]);
  otpChars.push(numbers[crypto.randomInt(0, numbers.length)]);
  otpChars.push(symbols[crypto.randomInt(0, symbols.length)]);

  // Fill the rest randomly
  while (otpChars.length < 6) {
    otpChars.push(allChars[crypto.randomInt(0, allChars.length)]);
  }

  // Shuffle to remove predictable order (Fisher-Yates, CSPRNG-driven —
  // Math.random()-based sort comparators are not a uniform shuffle either)
  for (let i = otpChars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [otpChars[i], otpChars[j]] = [otpChars[j], otpChars[i]];
  }

  return otpChars.join('');
};
