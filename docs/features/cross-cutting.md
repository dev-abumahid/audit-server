# Cross-cutting concepts

Everything below is shared infrastructure that most other modules depend on. Read this before
any of the per-module docs.

## Two-tier auth model

There are two distinct "role" concepts, and conflating them is a real source of bugs:

- **`Account.role`** (`ADMIN | USER | ORGANIZATION`) — the platform-level role checked by the
  `auth()` Express middleware. `ORGANIZATION` is what every tenant signup gets. `ADMIN` is a
  separate platform-operator role (e.g. used by `GET /organization`, which lists every tenant).
- **`OrgMember.role`** (`ADMIN | LEAD_AUDITOR | LIGHT_USER | VIEWER`) — the tenant-internal role
  from the multi-user org model. Resolved per-request by `resolveCallerOrgContext(accountId)` in
  `src/app/utils/org_scope.ts` into a `CallerOrgContext { organizationId, role, orgMemberId }`.

## The `organizationId` landmine

`CallerOrgContext.organizationId` is **not** `Organization.id`, despite the name. It's
`Organization.anchorAccountId` — the legacy `Account.id` that every domain table's
`orgAccountId` / `org_account_id` column actually filters by.

A caller with no `OrgMember` row at all (a pre-multi-tenant account) falls back to
`{ organizationId: accountId, role: 'ADMIN', orgMemberId: null }` — effectively "ADMIN of
yourself."

Endpoints that need the **real** `Organization.id` (to query `OrgMember` / `OrgInvitation` /
`OrgAuditLog`) must call `requireCallerOrganizationId(ctx)` instead, which 403s if the caller
has no real multi-member org.

`ExternalCallerContext` (used by external light users, see below) carries **both** fields with
distinct meanings: `.organizationId` (anchor Account.id, same meaning as above) and `.orgId`
(the real `Organization.id`, needed for `OrgAuditLog`/`recordOrgAuditEvent`). Confusing these
two was a real bug (aexa-server#252 round 1: the external-member edit path skipped
closure-cycle invalidation because it read `.organizationId` where `.orgId` was needed).

## Role-scoping helpers (`org_scope.ts`)

The actual authorization engine used across almost every module:

- `assertCanWriteOrgResource(ctx)` — ADMIN or LEAD_AUDITOR only. Gates Site/Template/Risk/KRI/
  Compliance/Audit/RiskLink/Report writes.
- `assertIsOrgAdmin(ctx)` — ADMIN only. Gates invite management, risk approval decisions,
  template-access grants, org settings, report publishing.
- `assertCanWriteToInspection(ctx, inspectionId)` — ADMIN always; LEAD_AUDITOR only if assigned
  via `InspectionAssignment`; VIEWER/LIGHT_USER never.
- `assertCanWriteToAction(ctx, action)` — same as above, plus LIGHT_USER is allowed only if they
  hold a live (`ACTIVE`, non-revoked) `FindingAssignment` for that exact finding.
- `assertCanReassignLineOfDefense(ctx)` — third-line-independence rule (aexa-frontend#208):
  reassigning an item's `line_of_defense` is restricted more tightly than ordinary writes to
  that item, to preserve the independence the "third line" classification is supposed to mean.
- `applyInspectionScope` / `applyActionScope` — read-side row filters implementing the same
  rules for list/get endpoints, with a Viewer-specific distinction: never-assigned means an
  org-wide fallback (see all), but all-assignments-revoked means deny (see `getInspectionAssignmentState`).
  `applyActionScope` takes an `idField` (`'id' | 'inspectionId'`) because the model being
  filtered decides which column carries the caller's grant — see
  [action-findings.md](action-findings.md) for why this is parameterized rather than fixed.
- `recordOrgAuditEvent(...)` — fire-and-forget writer to `OrgAuditLog`, never allowed to fail
  the request it's logging.

## Session & token handling

- **JWT verification failures are classed, not string-matched.** The reset-password and
  verify-link paths in `account.service.ts` branch on `jwt.TokenExpiredError` first (it
  subclasses `JsonWebTokenError`, so order matters if the expiry message is to stay distinct),
  then `jwt.JsonWebTokenError` for everything else — malformed, wrong signature, wrong algorithm.
  This used to match two specific error _message strings_, so every other token failure fell
  through as an unhandled 500 rather than a clean 401 (#285). The `auth` and `auth_external`
  middlewares follow the same shape.
- **Social login rejects soft-deleted accounts.** `accountCreatorHelper.ts` hard-rejects an
  account with `isDeleted` set, matching what the email/password path already did — otherwise a
  deactivated user could still get back in through any configured OAuth provider (#286).
- **`express-session` is Redis-backed** (`connect-redis`, `sess:` prefix), not
  `express-session`'s default `MemoryStore` — which leaks by design and is per-process, so
  sessions didn't survive across replicas (#303). Pinned to `connect-redis@6` deliberately: v7+
  rewrote `RedisStore` around the node-redis v4 client API, which isn't wire-compatible with the
  `ioredis` connection this app already shares across BullMQ and rate limiting.
- **Email queues have retention windows.** The OTP, reset-password, org-invite and
  external-verification BullMQ queues set `removeOnComplete` (1h / 100 jobs) and `removeOnFail`
  (24h / 500 jobs). Job payloads carry plaintext OTPs and reset tokens; with BullMQ's default
  retention those sat in Redis indefinitely, long outliving the 5-minute secrets themselves
  (#301).
- **Errors never leak driver detail.** The global error handler returns a fixed
  `"Something went wrong"` for any `Error` the app didn't deliberately craft as an `AppError`,
  logging the real one server-side instead. Raw Prisma/driver messages can carry table names,
  column names, and fragments of query values (#291).
- **Graceful shutdown**: `SIGTERM`/`SIGINT` stop accepting new connections, drain in-flight
  requests, then close DB/Redis handles. `tini` runs as PID 1 in the container so those signals
  actually reach node instead of being swallowed by a shell (#307).

## Uploaded-file lifecycle

Multer writes an upload to local disk before any handler logic runs, so anything that throws
between that write and the Cloudinary upload orphaned the file permanently — a role check
rejecting the request, a validation failure, or the client disconnecting mid-upload (#305,
#309).

Cleanup is wired into the global error handler _and_ both the `finish` and `close` response
events — `close` is the one that fires on a client abort, where `finish` never does. A
symbol-keyed `markFileHandled` flag marks a file whose disk lifecycle `uploadCloud` has already
taken ownership of, so the safety net can't race or double-delete a file that's mid-upload. The
flag is explicit rather than an `fs.existsSync` check because existence-checking races:
best-effort attachment uploads (see `note.service.ts`) can still be in flight after the response
has finished, so "the file is still on disk" does not mean "nobody is handling it."

## `OrgAuditLog`

The durable compliance trail: append-only, one row per lifecycle event. Enum values include
`MEMBER_INVITED`, `FINDING_ASSIGNMENT_APPROVED`, `RISK_SUBMITTED_FOR_APPROVAL`,
`ORG_SETTINGS_CHANGED`, `EXTERNAL_MEMBER_LOGIN_SUCCEEDED`, `ACTION_CLOSURE_SUBMITTED`,
`ACTION_CLOSURE_APPROVED`, `ACTION_CLOSURE_REJECTED`, `ACTION_CLOSURE_INVALIDATED`, and more
(full list in `organization.schema.prisma`'s `OrgAuditAction`). Every privileged mutation across
Risk approvals, Action closure/assignment, Inspection assignments, and org membership writes one
of these.

## External / light-user access model

`ExternalOrgMember` is a non-`Account` identity (no password, no normal-login JWT) scoped to
exactly one `Organization`, restricted today to role `LIGHT_USER` only — external `VIEWER` is
schema-modeled but explicitly rejected at every entry point pending inspection-level scoping
work.

Auth is OTP-based (`external-auth.service.ts`, `request_verification_code` /
`verify_code_and_login`) with real anti-enumeration engineering:

- Constant-time dummy bcrypt compare (`DUMMY_CODE_HASH`) plus a dummy-member-id lookup path so
  DB round-trip counts don't leak "does this email exist."
- Per-code `failedAttempts` / `lockedUntil` with atomic increments.
- A single generic 401 message/status for every failure mode.

An external Light User's actual authority is a `FindingAssignment` row scoped to
`externalOrgMemberId` — the same mechanism as internal Light Users (see
[Findings / Actions](action-findings.md)).

## Org membership lifecycle (`organization` module)

- `invite_member_into_db` — admin-only; refreshes and resends a pending invite for the same
  email rather than rejecting a duplicate invite.
- `accept_invitation_into_db` — single public endpoint branching on whether the invited email
  already has an `Account`: an existing account authenticates by password; a new email creates
  Account+Profile+OrgMember atomically. One-account-one-org is enforced.
- `update_org_member_in_db` — SUSPENDED/`expiresAt` offboarding, wrapped in a `Serializable`-
  isolation transaction with last-admin-protection (an org can never be left with zero admins).
- External-member invite/list/update mirrors the internal flow, minus admin-lockout logic
  (external members are never ADMIN).
