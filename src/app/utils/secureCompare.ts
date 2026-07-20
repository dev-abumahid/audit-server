import crypto from 'crypto';

// Constant-time string comparison for secrets (OTPs, verification codes, etc).
// `a === b` is a timing side-channel: a naive comparison returns as soon as it
// finds a mismatching character, so response time leaks how many leading
// characters an attacker guessed correctly, letting the secret be recovered
// digit-by-digit. `crypto.timingSafeEqual` closes that channel, but only for
// buffers of equal length — it throws on a length mismatch, and even if we
// caught that, branching on "lengths differ" before calling it would itself
// be a (cheaper, but still real) timing signal. Hashing both inputs to a
// fixed-length digest first means every call — same length, different
// length, empty input — takes the same code path through timingSafeEqual.
export const constantTimeStringEqual = (a: string, b: string): boolean => {
  const hashedA = crypto.createHash('sha256').update(a).digest();
  const hashedB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashedA, hashedB);
};
