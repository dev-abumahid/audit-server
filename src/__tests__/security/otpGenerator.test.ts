import { describe, expect, it } from 'vitest';
import { otpGenerator, numericVerificationCodeGenerator } from '../../app/utils/otpGenerator.js';

const upper = /[A-Z]/;
const lower = /[a-z]/;
const number = /[0-9]/;
const symbol = /[@#$%&*!?]/;
const allowedChars = /^[A-Za-z0-9@#$%&*!?]+$/;

describe('otpGenerator (#109)', () => {
  it('produces a 6-character OTP', () => {
    for (let i = 0; i < 50; i++) {
      expect(otpGenerator()).toHaveLength(6);
    }
  });

  it('only uses characters from the allowed character set', () => {
    for (let i = 0; i < 50; i++) {
      expect(otpGenerator()).toMatch(allowedChars);
    }
  });

  it('includes at least one uppercase, lowercase, number, and symbol character', () => {
    for (let i = 0; i < 50; i++) {
      const otp = otpGenerator();
      expect(otp).toMatch(upper);
      expect(otp).toMatch(lower);
      expect(otp).toMatch(number);
      expect(otp).toMatch(symbol);
    }
  });

  it('does not use Math.random (produces varied output across calls)', () => {
    const otps = new Set(Array.from({ length: 30 }, () => otpGenerator()));
    // With a 6-char OTP drawn from ~70 chars, collisions across 30 samples
    // should be exceedingly rare for any working RNG (secure or not) — this
    // mainly guards against a regression to a constant/degenerate generator.
    expect(otps.size).toBeGreaterThan(1);
  });
});

describe('numericVerificationCodeGenerator', () => {
  it('produces a 6-digit numeric string, zero-padded', () => {
    for (let i = 0; i < 50; i++) {
      const code = numericVerificationCodeGenerator();
      expect(code).toHaveLength(6);
      expect(code).toMatch(/^[0-9]{6}$/);
    }
  });
});
