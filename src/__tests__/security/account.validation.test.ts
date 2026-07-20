import { describe, expect, it } from 'vitest';
import {
  account_validation,
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
});

describe('account_validation.sing_in', () => {
  it('does NOT enforce the strength rule on login — must keep authenticating pre-existing short passwords', () => {
    const result = account_validation.sing_in.safeParse({
      email: 'user@example.com',
      password: 'old',
    });
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
