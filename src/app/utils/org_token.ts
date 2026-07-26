import jwt from 'jsonwebtoken';
import { configs } from '../configs/index.js';

// Issue #56 stage 2: aexa-server used to identify itself to aexa-ai (via
// X-Internal-Secret) but the *organization* on whose behalf a call was made
// was only ever a self-reported `X-Organization` header or, on most call
// sites, nothing at all -- meaning aexa-ai's per-org rate limiting either
// keyed off a value the caller could set to anything, or fell through to
// remote IP and shared one bucket across every org calling through
// aexa-server. aexa-ai's stage-1 change (PR #124 on aexa-ai) added a signed,
// verifiable alternative: a short-lived JWT carrying the real org id, keyed
// by `org_account_id`. This mints that token.
//
// Signed with the exact same secret aexa-server already sends as the
// X-Internal-Secret header (configs.ai_internal_secret) -- aexa-ai verifies
// with that identical shared secret (see its app/utils/org_token.py), so
// this deliberately does NOT introduce a second secret to provision or
// rotate between the two services. Whoever already holds this secret can
// already authenticate as aexa-server's internal caller (X-Internal-Secret
// is checked as a global auth dependency on every aexa-ai route), so signing
// an org-identity claim with it adds no new trust boundary -- it only turns
// an already-trusted caller's previously-unverifiable "which org is this
// for" claim into a verifiable one.
//
// TTL is intentionally short (60s): this is minted fresh on every single
// outbound aexa-ai call, never cached or reused across requests, so it only
// ever needs to survive one HTTP round-trip. A short TTL also limits how
// long a token would remain valid if it ever leaked into a log line.
const ORG_TOKEN_TTL_SECONDS = 60;

// Must match aexa-ai's app/utils/org_token.py ORG_ACCOUNT_ID_CLAIM exactly --
// aexa-ai's verifier reads this specific claim name out of the JWT payload.
const ORG_ACCOUNT_ID_CLAIM = 'org_account_id';

/**
 * Mints a short-lived HS256 JWT asserting the caller's real org identity, for
 * aexa-ai's rate limiter (`app/limiter.py`'s `get_org_key`) to verify and key
 * on instead of a self-reported header. Call this fresh for every outbound
 * aexa-ai request -- it is not meant to be cached or reused.
 */
export const mintOrgToken = (orgAccountId: string): string => {
  return jwt.sign({ [ORG_ACCOUNT_ID_CLAIM]: orgAccountId }, configs.ai_internal_secret, {
    algorithm: 'HS256',
    expiresIn: ORG_TOKEN_TTL_SECONDS,
  });
};

// The header aexa-ai's rate limiter reads this token from (its
// settings.auth.org_token_header, currently "X-Org-Token"). Exported so every
// call site attaches it under the identical name aexa-ai actually checks.
export const ORG_TOKEN_HEADER = 'X-Org-Token';
