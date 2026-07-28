# Onboarding

The zero-input tenant-onboarding wizard (#96) — a 4-stage pipeline:

1. **Identify** — AI company-profile lookup.
2. **Generate baseline** — per-site AI risk analysis plus one shared `/kri-baseline` call,
   attaching each category's KRI templates to the first risk of that category per site. Not
   persisted at this stage.
3. **Commit** — the only stage that persists, and it persists **everything in one single
   transaction**: Account + OrganizationProfile + Organization + OrgMember + Sites + Risks +
   KRIs. This explicitly fixes a real bug in the Fullbloom reference implementation, which does
   8 un-transacted sequential inserts with no rollback.

Probability normalization guards against an LLM emitting a bare percentage (e.g. `70`) instead
of a `0–1` fraction, and the AI-drafted `inherent_score` is clamped to 0–100 via the shared
`clampPercent` — in the service, and again as a bound in `onboarding.validation.ts` so an
out-of-range score can't reach the column even if it bypasses the service-level clamp. See
[risk.md](risk.md) for why every AI-derived score producer clamps.

KRIs seeded this way carry `ai_generated: true` so the UI can show the same "AI-generated,
review recommended" treatment as an AI-generated Risk.

## Frontend wiring (aexa-frontend)

**Fully wired, but admin-only — not self-service.** The 4-stage wizard (identify → generate
baseline → review → commit) lives exclusively inside the internal-admin `/admin/organizations`
area, reachable only by the platform's Qiyrix-internal admin account type. A newly signed-up
organization has **no onboarding entry point in its own dashboard** — this wizard is a tool the
platform's internal team uses to spin up a new org on a customer's behalf, not something an
organization walks through itself after self-service signup.
