import { describe, expect, it } from 'vitest';
import { orgInviteEmailTemplate } from '../../app/templates/orgInviteEmailTemplate.js';

describe('orgInviteEmailTemplate — HTML injection via organizationName', () => {
  it('escapes an HTML-injection payload in organizationName before it reaches the email body', () => {
    const html = orgInviteEmailTemplate({
      email: 'invitee@test.com',
      organizationName: '<script>alert(document.cookie)</script>',
      inviteLink: 'https://app.example.com/invite/abc123/accept',
    } as any);

    expect(html).not.toContain('<script>alert(document.cookie)</script>');
    expect(html).toContain('&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
  });

  it('does not escape the server-generated inviteLink (not user input)', () => {
    const html = orgInviteEmailTemplate({
      email: 'invitee@test.com',
      organizationName: 'Acme Inc',
      inviteLink: 'https://app.example.com/invite/abc123/accept',
    } as any);

    expect(html).toContain('href="https://app.example.com/invite/abc123/accept"');
  });

  it('renders a normal organization name unchanged', () => {
    const html = orgInviteEmailTemplate({
      email: 'invitee@test.com',
      organizationName: "Bob's Auditing & Sons",
      inviteLink: 'https://app.example.com/invite/abc123/accept',
    } as any);

    expect(html).toContain('Bob&#39;s Auditing &amp; Sons');
  });
});
