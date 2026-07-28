# Account & organization

## `account` module

Authentication/identity root. Local + social (Google/Facebook/Twitter/GitHub/LinkedIn/
Instagram) login, OTP email verification (constant-time compare via `constantTimeStringEqual`,
5-minute expiry), JWT-based reset-password flow. `SAFE_ACCOUNT_SELECT` ensures the bcrypt hash
never leaves the process in any response.

Signup atomically creates Account + OrganizationProfile + Organization + OrgMember(`ADMIN`) in
one transaction — the same shared helper used by both admin-provisioned orgs and the onboarding
wizard's commit stage (see [onboarding.md](onboarding.md)).

**Emailed links.** All three link shapes are built the same way, `?token=<jwt>`: email
verification and resend-OTP both point at `/verify/token`, reset-password at `/reset-password`.
The two verification links previously emitted `?=token<jwt>` — a malformed query string with no
parameter name — so every signup and resend verification link in the wild was simply unusable
(#281). The reset-password link was always correct; it's the shape to copy.

Auth-path behaviors documented in [cross-cutting.md](cross-cutting.md) that live in this module:
JWT failures are classed rather than message-matched, so a malformed or wrong-signature token
returns a clean 401 instead of a 500 (#285); and social login rejects `isDeleted` accounts,
matching the email/password path — a deactivated user could otherwise still get back in through
any configured OAuth provider (#286).

## `organization` module

Covers org membership lifecycle (see [cross-cutting.md](cross-cutting.md) for the invite/
accept/offboarding flow and last-admin-protection), org settings, external-member management,
and `get_all_organizations_from_db` — the platform-`ADMIN`-only cross-tenant listing endpoint
(distinct from any tenant-internal role; see the two-tier auth model in cross-cutting.md).

## `external-auth` module

Implements the OTP login flow for external Light Users described in
[cross-cutting.md](cross-cutting.md)'s external/light-user access section — the
enumeration-resistant `request_verification_code` / `verify_code_and_login` pair.

## `profile` module

Single upsert endpoint. Self-signed-up "anchor" accounts never get a `Profile` row at signup
(only invited members do) — upsert makes the first-ever edit work uniformly for both cases.

## Frontend wiring (aexa-frontend)

- **Login/signup/social login/email-verification-OTP** — all wired (see
  [frontend-overview.md](frontend-overview.md) for the session model: an httpOnly cookie, not a
  client-held JWT).
- **Multi-user org roles** — member list, invite, resend invite, suspend/reactivate are all
  wired under org settings.
- **External Light-User OTP login is wired**, on its own route tree rather than folded into the
  normal sign-in: `/external-login/:organizationId` hosts the request-code / verify-code pair,
  and `/external` is the portal itself, behind `ExternalProtectedRoute`. It reads a separate
  `externalUser` session slice, deliberately not the internal user session — an external member
  is not an `Account`, and keeping the two sessions distinct means neither flow can ever be
  mistaken for the other. The `external-auth` backend flow is live end-to-end.
- **Accept-invitation flow for internal (non-external) members** is also not a dedicated UI —
  only invite/resend/suspend are wired; there's no page for an invited user to complete signup
  and land in the org, beyond whatever the generic sign-in/sign-up modals happen to cover.
