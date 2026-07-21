import { describe, expect, it } from 'vitest';
import { otpEmailTemplate } from '../../app/templates/otpEmailTemplate.js';

describe('otpEmailTemplate — no third-party-hosted image', () => {
  it('does not reference the third-party ibb.co logo URL (#129)', () => {
    const html = otpEmailTemplate({
      email: 'user@test.com',
      otp: '123456',
      verificationLink: 'https://app.example.com/verify/abc123',
    });

    expect(html).not.toContain('https://i.ibb.co.com/TnKvMyg/democompany.png');
    expect(html).not.toMatch(/<img[^>]*ibb\.co/);
  });

  it('still renders the OTP digits and verification link', () => {
    const html = otpEmailTemplate({
      email: 'user@test.com',
      otp: '123456',
      verificationLink: 'https://app.example.com/verify/abc123',
    });

    expect(html).toContain('1');
    expect(html).toContain('href="https://app.example.com/verify/abc123"');
  });
});
