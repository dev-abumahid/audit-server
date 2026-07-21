import { describe, expect, it } from 'vitest';
import {
  account_validation,
  emailSchema,
  passwordSchema,
} from '../../app/modules/account/account.validation.js';

describe('passwordSchema (issue #113)', () => {
  it('rejects a too-short password', () => {
    const result = passwordSchema.safeParse('abc123');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Password must be at least 10 characters.');
    }
  });

  it('rejects a password with no digits, even if long enough', () => {
    const result = passwordSchema.safeParse('longenoughpassword');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('at least one number'))).toBe(true);
    }
  });

  it('rejects a password with no letters, even if long enough', () => {
    const result = passwordSchema.safeParse('1234567890');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('at least one letter'))).toBe(true);
    }
  });

  it('accepts a valid password (10+ chars, letter + number)', () => {
    const result = passwordSchema.safeParse('correcthorse1');
    expect(result.success).toBe(true);
  });
});

describe('emailSchema (issue #121)', () => {
  it('rejects a string with no @', () => {
    const result = emailSchema.safeParse('not-an-email');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Must be a valid email address.');
    }
  });

  it('rejects a string missing a domain', () => {
    const result = emailSchema.safeParse('user@');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Must be a valid email address.');
    }
  });

  it('rejects an empty string', () => {
    const result = emailSchema.safeParse('');
    expect(result.success).toBe(false);
  });

  it('rejects an email longer than 255 characters', () => {
    const longLocalPart = 'a'.repeat(250);
    const result = emailSchema.safeParse(`${longLocalPart}@example.com`);
    expect(result.success).toBe(false);
  });

  it('accepts a valid email address', () => {
    const result = emailSchema.safeParse('user@example.com');
    expect(result.success).toBe(true);
  });

  it('accepts a valid email address with a subdomain and plus-tag', () => {
    const result = emailSchema.safeParse('user+tag@mail.example.co.uk');
    expect(result.success).toBe(true);
  });
});

describe('account_validation.sign_up', () => {
  const BASE = {
    email: 'user@example.com',
    organizationName: 'Acme Inc',
  };

  it('rejects a weak password at signup', () => {
    const result = account_validation.sign_up.safeParse({ ...BASE, password: 'short1' });
    expect(result.success).toBe(false);
  });

  it('accepts a strong password at signup', () => {
    const result = account_validation.sign_up.safeParse({ ...BASE, password: 'correcthorse1' });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid email format at signup', () => {
    const result = account_validation.sign_up.safeParse({
      ...BASE,
      email: 'not-an-email',
      password: 'correcthorse1',
    });
    expect(result.success).toBe(false);
  });
});

describe('account_validation.sing_in', () => {
  it('does NOT enforce the strength rule on login — must keep authenticating pre-existing short passwords', () => {
    const result = account_validation.sing_in.safeParse({
      email: 'user@example.com',
      password: 'old',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid email format at login', () => {
    const result = account_validation.sing_in.safeParse({
      email: 'not-an-email',
      password: 'old',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid email format at login', () => {
    const result = account_validation.sing_in.safeParse({
      email: 'user@example.com',
      password: 'old',
    });
    expect(result.success).toBe(true);
  });
});

describe('account_validation.verify_otp', () => {
  it('rejects an invalid email format', () => {
    const result = account_validation.verify_otp.safeParse({
      email: 'not-an-email',
      otp: '123456',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid email format', () => {
    const result = account_validation.verify_otp.safeParse({
      email: 'user@example.com',
      otp: '123456',
    });
    expect(result.success).toBe(true);
  });
});

describe('account_validation.resend_otp', () => {
  it('rejects an invalid email format', () => {
    const result = account_validation.resend_otp.safeParse({ email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid email format', () => {
    const result = account_validation.resend_otp.safeParse({ email: 'user@example.com' });
    expect(result.success).toBe(true);
  });
});

describe('account_validation.change_password', () => {
  it('rejects a weak newPassword', () => {
    const result = account_validation.change_password.safeParse({
      oldPassword: 'whatever-old-value',
      newPassword: 'weak1',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a strong newPassword', () => {
    const result = account_validation.change_password.safeParse({
      oldPassword: 'whatever-old-value',
      newPassword: 'correcthorse1',
    });
    expect(result.success).toBe(true);
  });

  it('does NOT enforce the strength rule on oldPassword — it authenticates an already-stored password', () => {
    const result = account_validation.change_password.safeParse({
      oldPassword: 'old',
      newPassword: 'correcthorse1',
    });
    expect(result.success).toBe(true);
  });
});

describe('account_validation.reset_pass', () => {
  it('rejects a weak newPass', () => {
    const result = account_validation.reset_pass.safeParse({
      token: 'some-token',
      newPass: 'weak1',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a strong newPass', () => {
    const result = account_validation.reset_pass.safeParse({
      token: 'some-token',
      newPass: 'correcthorse1',
    });
    expect(result.success).toBe(true);
  });
});
