import { describe, expect, it } from 'vitest';
import { resetPasswordEmailTemplate } from '../../app/templates/resetPasswordEmailTemplate.js';

describe('resetPasswordEmailTemplate — no third-party-hosted image', () => {
  it('does not reference the third-party ibb.co logo URL (#129)', () => {
    const html = resetPasswordEmailTemplate('https://app.example.com/reset/abc123');

    expect(html).not.toContain('https://i.ibb.co.com/TnKvMyg/democompany.png');
    expect(html).not.toMatch(/<img[^>]*ibb\.co/);
  });
});
