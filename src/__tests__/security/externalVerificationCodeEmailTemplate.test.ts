import { describe, expect, it } from 'vitest';
import { externalVerificationCodeEmailTemplate } from '../../app/templates/externalVerificationCodeEmailTemplate.js';

describe('externalVerificationCodeEmailTemplate — no third-party-hosted image', () => {
  it('does not reference the third-party ibb.co logo URL (#129)', () => {
    const html = externalVerificationCodeEmailTemplate({
      email: 'user@test.com',
      code: '123456',
      organizationName: 'Acme Inc',
    });

    expect(html).not.toContain('https://i.ibb.co.com/TnKvMyg/democompany.png');
    expect(html).not.toMatch(/<img[^>]*ibb\.co/);
  });
});
