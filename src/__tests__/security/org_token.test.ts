import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { mintOrgToken, ORG_TOKEN_HEADER } from '../../app/utils/org_token.js';

// setup.ts sets AI_INTERNAL_SECRET = 'test-ai-internal-secret' before any
// module import reads configs, so this is the exact secret mintOrgToken
// signs with in this test run — matches configs.ai_internal_secret.
const SIGNING_SECRET = 'test-ai-internal-secret';

describe('mintOrgToken (issue #56)', () => {
  it('produces a JWT verifiable with the shared AI_INTERNAL_SECRET', () => {
    const token = mintOrgToken('org-abc-123');

    // Must not throw — proves it's signed with the exact secret aexa-ai
    // verifies with (configs.ai_internal_secret / AI_INTERNAL_SECRET env).
    expect(() => jwt.verify(token, SIGNING_SECRET)).not.toThrow();
  });

  it('rejects verification against a different secret (proves it is actually signed, not forgeable)', () => {
    const token = mintOrgToken('org-abc-123');

    expect(() => jwt.verify(token, 'a-different-secret')).toThrow();
  });

  it('carries the org_account_id claim aexa-ai reads (app/utils/org_token.py)', () => {
    const token = mintOrgToken('org-abc-123');

    const payload = jwt.verify(token, SIGNING_SECRET) as jwt.JwtPayload;
    expect(payload.org_account_id).toBe('org-abc-123');
  });

  it("uses HS256, matching aexa-ai's verifier", () => {
    const token = mintOrgToken('org-abc-123');

    const decoded = jwt.decode(token, { complete: true });
    expect(decoded?.header.alg).toBe('HS256');
  });

  it('sets a short expiry (~60s) rather than a long-lived token', () => {
    const before = Math.floor(Date.now() / 1000);
    const token = mintOrgToken('org-abc-123');
    const after = Math.floor(Date.now() / 1000);

    const payload = jwt.verify(token, SIGNING_SECRET) as jwt.JwtPayload;
    expect(payload.exp).toBeDefined();
    // exp is a unix timestamp (seconds), ~60s after mint time — generous
    // bounds around the intended TTL to avoid test flakiness on slow CI.
    expect(payload.exp).toBeGreaterThanOrEqual(before + 55);
    expect(payload.exp).toBeLessThanOrEqual(after + 65);
  });

  it('mints an independent token per call rather than returning a cached value', () => {
    // mintOrgToken has no module-level cache/memoization — each call is a
    // fresh jwt.sign, so a different org id on a second call must produce a
    // token carrying THAT org id, not a stale one from a prior call.
    const first = mintOrgToken('org-abc-123');
    const second = mintOrgToken('org-xyz-789');

    expect(jwt.verify(first, SIGNING_SECRET)).toMatchObject({ org_account_id: 'org-abc-123' });
    expect(jwt.verify(second, SIGNING_SECRET)).toMatchObject({ org_account_id: 'org-xyz-789' });
  });

  it('exports the header name matching aexa-ai\'s settings.auth.org_token_header ("X-Org-Token")', () => {
    expect(ORG_TOKEN_HEADER).toBe('X-Org-Token');
  });
});
