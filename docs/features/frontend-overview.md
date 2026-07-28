# aexa-frontend overview

This covers aexa-frontend's own structure — routing, role-gating behavior, and auth/session
model. For per-feature wiring status (what's actually built for each backend capability), see
the "Frontend wiring" section in each module's own doc.

## Routing / navigation

Router: `src/routes/MainRoute.tsx` (`createBrowserRouter`), three top-level branches:

- **Public** (`/`): Home, terms, privacy, reset-password.
- **`/organization`** (account role `"ORGANIZATION"` — this is the *account*-level role; it does
  **not** distinguish `LEAD_AUDITOR`/`LIGHT_USER`/`VIEWER`, see below): dashboard, sites,
  risks/risk-matrix/correlation-matrix/risk-graph, KRIs, intelligence, alerts, compliance,
  three-lines-of-defense, audit (templates/inspections/reports/run-workflow), findings, reports,
  settings.
- **`/admin`** (account role `"ADMIN"` — Qiyrix-internal super-admin, not an org's internal
  `ADMIN` org-role): admin overview, transactions, organizations (hosts the onboarding wizard),
  admin settings.

Nav is grouped into three labeled sections in the sidebar: **Analyze** (Dashboard, Sites, Risk
Register, 5×5 Matrix, Correlation Matrix, PageRank Graph, KRI Dashboard), **Intelligence**
(Threat Intel, Alerts), **Governance** (Compliance, Three Lines of Defense, Audit, Templates,
Inspections, Findings, Reports).

## Role-based UI behavior — coarser than the backend model

- **Route-level gating only distinguishes account type**, not org role. `ProtectedRoute.tsx`
  checks `"ADMIN"` (internal) vs. `"ORGANIZATION"` (any org member) — all four `OrgRole` values
  (`ADMIN`/`LEAD_AUDITOR`/`LIGHT_USER`/`VIEWER`) reach the exact same set of `/organization/*`
  routes. There is no route guard restricting a `LIGHT_USER` to inspection-related pages, or
  blocking a `VIEWER` from settings. (External light users are the exception — they get their
  own top-level `/external` tree behind `ExternalProtectedRoute`, checking a wholly separate
  session slice; see [account-organization.md](account-organization.md).)
- **Fine-grained gating runs through `useMyOrgRole()`** — client-computed by cross-referencing
  `GET /auth/me` against `GET /organization/members` (readable by any active member, so every
  role can resolve its own), with a fallback-to-ADMIN mirroring the server's ADMIN-of-self
  fallback for a solo account. It returns `undefined` while loading, so callers hold off
  rendering rather than flashing an ADMIN-defaulted UI at a Lead Auditor. It's a UX convenience
  only — every real check is re-verified server-side.
- **Base entity CRUD is gated**, via the shared `canWriteOrgResource(role)` predicate
  (`ADMIN || LEAD_AUDITOR`). Create/Edit/Delete affordances are hidden from `VIEWER`/`LIGHT_USER`
  across Risk Register, Compliance, KRIs, Sites, Findings, Audit, Templates, Inspections, Reports
  (Generate), Intelligence, and the settings Team-Members and External-Members tabs. `undefined`
  (role still loading) is treated as "hide" — the same conservative default every
  `useMyOrgRole()` consumer uses.

**What that gating deliberately does *not* cover** — the two places a user can still meet a 403:

- **No row-level assignment gating.** `canWriteOrgResource` is role-only, while the server's real
  rule is narrower for two roles: a `LEAD_AUDITOR` can only write to inspections they're assigned
  to (`InspectionAssignment`), and a `LIGHT_USER` only to findings they hold a live
  `FindingAssignment` for. The frontend has no access to that assignment data today, so it offers
  both roles actions the server may still reject. This is a deliberate limit of the gate, not an
  oversight — gating on role alone fixes the "looks broken for a Viewer" problem without
  pretending to know assignment state it can't see.
- **No route guards on the write surfaces themselves.** Gating hides controls on list and detail
  pages; the routes behind them (template create/edit, inspection create/edit, the
  run-inspection page) have no role guard of their own. A `VIEWER` who deep-links or bookmarks
  one still reaches a full editing surface, and only learns otherwise on submit.

## Auth / session model

- **Login**: plain email+password (`SignInModal.tsx`, `POST /auth/sign-in`), same flow for every
  org role.
- **Session storage**: an **httpOnly cookie** — `baseApi.ts`'s `fetchBaseQuery` uses
  `credentials: "include"`, no bearer-token/localStorage handling of the JWT itself. What *is*
  persisted to `localStorage` (via `redux-persist`) is just the lightweight `IUser` profile
  object (email/id/role/provider) — used purely for UI state, not as a credential.
- **Cache reset at every session transition.** Sign-in, logout, and the global 401 handler all
  dispatch `baseApi.util.resetApiState()`. This is a **cross-tenant isolation** requirement, not
  housekeeping: the RTK Query cache is keyed by endpoint and args, never by account, so switching
  accounts in one tab would otherwise serve the previous tenant's risks, findings and member list
  straight from cache until each query happened to refetch. Logout also dispatches `removeUser()`
  in both `AdminLayout` and `OrganizationLayout` — the admin layout's Logout was previously a
  dead link that navigated away without clearing session state at all.
- **Global 401 handling**: any 401 outside `/auth/*` triggers a logout, full RTK Query cache
  reset, and hard redirect to `/`.
- **Sign-up + OTP**: OTP is used for post-signup **email verification** only, not as a login
  mechanism for a normal account.
- **Social login**: conditionally renders only providers the backend reports as configured;
  real-navigation OAuth redirect (can't go through RTK Query).
- **External light-user OTP login is wired**, as a separate session on a separate route tree:
  `/external-login/:organizationId` for the OTP request/verify pair, and `/external` behind
  `ExternalProtectedRoute` for the portal itself. It reads its own `externalUser` slice, not the
  internal user session, so the two can never be confused for one another. See
  [account-organization.md](account-organization.md).

## Shared conventions across list/CRUD pages

Four patterns are shared rather than re-implemented per page. Each exists because the ad-hoc
versions diverged and each divergence was a bug; reach for the shared one when adding a page.

- **`useClampPageToTotal`** — clamps the current page index when the total shrinks. Deleting the
  last row on a filtered or paginated page otherwise stranded the user on a now-out-of-range
  empty page with no control to get back. Used by Templates, Inspections, Sites, Findings,
  Compliance and Audit (#265).
- **`DeleteAlertModal`** — the shared delete confirmation behind seven delete flows, fully
  internationalized with sensible default title/description keys. It was the one shared component
  still shipping hardcoded English into an otherwise fully translated `fr` build (#263).
- **Object-URL cleanup for image previews** — any `URL.createObjectURL` preview (template logo
  in create and edit, profile photo) is revoked on replacement and unmount. The template logo
  minted a fresh blob URL on every render, which both leaked and produced a visible flicker
  (#259).
- **Cache-tag discipline on mutations.** RTK Query tags are the only thing refreshing a
  cross-page view, so a mutation must invalidate every tag whose data it changes — not just the
  tag of the entity it names. Several mutations invalidated only their own: deleting a note
  didn't invalidate `INSPECTION` (#229), and creating an action from a correlation bucket,
  creating a risk from an intelligence item, and risk create/update/delete each left
  `CORRELATION_MATRIX` or `RISK` stale (#261). The rule of thumb: if another page renders this
  data under a different tag, invalidate that tag too.

## Frontend-only features (no backend capability behind them)

- **EBITDA percentile chart** on the dashboard — explicitly static placeholder data (the
  frontend's own code comment: "No backend endpoint returns EBITDA percentile data anywhere in
  this project"), including a hardcoded revenue metric card.
- **Client-side PageRank computation** (`src/utils/pageRank.ts`) — the dashboard's "Systemic
  Tipping Points" section and the standalone PageRank Graph page compute real graph centrality
  client-side from `RiskLink` correlation edges. This is explicitly distinct from the
  manually-entered `Risk.pagerank_score` DB field, which is never derived from anything today.
- **i18n** (`react-i18next`) — `en.json`/`fr.json` only on `main`, fully translated.
- **Client-rendered PDF/HTML export** for inspections/templates — independent of the backend's
  own `Report` PUBLISHED/board-generation pipeline.
- **redux-persist** for the lightweight user profile slice only (not the RTK Query cache) — a
  convenience so role/profile info survives a hard refresh without re-fetching.
