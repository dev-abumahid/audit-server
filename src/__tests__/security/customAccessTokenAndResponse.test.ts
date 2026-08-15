import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { configs } from '../../app/configs/index.js';
import { customAccessTokenAndResponse } from '../../app/passport-js/customAccessTokenAndResponse.js';

/**
 * Found live while testing the qiyrix.com AWS cutover: every OAuth provider
 * callback (google/facebook/twitter/github, account.route.ts) used to just
 * return this function's raw JSON response, leaving the browser sitting on
 * api.<domain>/api/auth/social/.../callback showing a JSON blob instead of
 * ever landing back in the app -- would have behaved identically on the old
 * globalriskcore.com setup too, it was just never exercised end-to-end in a
 * real browser before. Now redirects to FRONT_END_URL (already used
 * elsewhere for invite/verification/reset-password links, account.service.ts/
 * organization.service.ts) so the SPA's own useGetMeQuery bootstrap check
 * picks up the session via the cookie this function sets.
 */
function buildApp() {
  const app = express();
  app.get('/callback', (req: any, res) => {
    req.user = { id: 'acc-1', email: 'test@example.com', role: 'ORGANIZATION' };
    customAccessTokenAndResponse(req, res);
  });
  return app;
}

describe('customAccessTokenAndResponse', () => {
  const originalFrontEndUrl = configs.jwt.front_end_url;

  afterEach(() => {
    configs.jwt.front_end_url = originalFrontEndUrl;
  });

  it('redirects to FRONT_END_URL when configured', async () => {
    const res = await request(buildApp()).get('/callback');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173');
  });

  it('still sets the access_token cookie on the redirect response', async () => {
    const res = await request(buildApp()).get('/callback');

    const cookie = res.headers['set-cookie'];
    expect(cookie, 'should set a cookie').toBeTruthy();
    expect(cookie[0]).toMatch(/^access_token=/);
  });

  it('does not leak the access token into the redirect URL', async () => {
    const res = await request(buildApp()).get('/callback');

    expect(res.headers.location).not.toMatch(/access_token|token=/);
  });

  it('falls back to the original JSON response when FRONT_END_URL is not configured', async () => {
    configs.jwt.front_end_url = undefined;

    const res = await request(buildApp()).get('/callback');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'Login successfully' });
    expect(res.body.data.accessToken).toEqual(expect.any(String));
  });
});
