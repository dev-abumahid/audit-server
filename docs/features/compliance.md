# Compliance obligations

`ComplianceObligation` — a regulatory/control obligation, optionally site-scoped (org-wide if
`site_id` is null, e.g. a SOX control vs. a local environmental permit), with a loose-string
`status` (`compliant` / `non_compliant` / `in_progress` / `not_applicable`) and a `domain`
grouping axis (free-text, paired with a curated frontend constant, same pattern as
`Risk.category`).

## Evidence-gating (#243)

`attachments` is no longer purely decorative: `assertCompliantHasEvidence`
(`compliance.service.ts`) hard-gates `status: 'compliant'` on at least one attachment entry — a
GRC product whose value proposition includes audit-readiness can't let an unbacked "compliant"
claim through.

## Regulatory source (#243)

`regulation_reference` — free text naming which specific law/regulation/clause the obligation
derives from (a core ISO 37301 obligations-register column). Deliberately free text rather than
a structured regulation+clause reference or a seeded taxonomy, matching how `domain` stays a
free string — simplest to ship first; a structured reference table would be a separate, bigger
change.

## Recurrence & re-attestation (#250)

Modern compliance practice is continuous oversight, not point-in-time — an annual filing
obligation was previously indistinguishable from a one-time one.

- `recurrence` — one of `monthly` | `quarterly` | `annual`, or `null`/`one_time`. See
  `compliance.service.ts`'s `RECURRENCE_INTERVAL_DAYS` for the cadence→days mapping.
- `next_review_date` — **derived, not independently client-settable** (stripped from create/
  update payloads). Seeded from `due_date` at creation when a recurrence is set (the first
  cycle's due date doubles as the first review date), then recomputed from `attested_at` + the
  cadence interval on every new `ComplianceAttestation`.
- **Overdue detection** reads `next_review_date` (falling back to `due_date` when unset) — so a
  recurring obligation that's gone stale since its last confirmation is flagged overdue even
  though its original one-time `due_date` already passed.
- `ComplianceAttestation` is an **append-only** re-attestation log (never updated/deleted),
  recording `attested_by`, `attested_at`, and a `status_at_attestation` snapshot (a fact about
  that point in time, not something that reinterprets itself if the obligation's live status
  later changes). Deliberately **not** a maker-checker submit/approve/reject cycle like
  `RiskApproval`/the finding-closure workflow — that level of independent verification is a
  separate, larger decision reserved for closing something; re-attestation here just answers
  "has someone recently reconfirmed this still holds."

## Scorecard

`get_compliance_scorecard_from_db` computes at request time (no caching, Phase 1): overall
ratio, by-domain, by-site, and a site×domain matrix. Each cell is banded per "CDC spec 7.7":
`green (≥85%) / orange (≥70%) / red (<70%) / none (no data)`.

## Classification & permissions

Defaults to `line_of_defense: SECOND`. Write actions gated by `assertCanWriteOrgResource`
(ADMIN/LEAD_AUDITOR).

## Frontend wiring (aexa-frontend)

- CRUD + scorecard is wired (Compliance page): obligation list with server-side pagination/
  filtering by domain/status/search, the site×domain scorecard grid with green/orange/red
  banding straight off `GET /compliance/scorecard`, attachment upload, and a "Create Action"
  shortcut for non-compliant rows.
- **Evidence-gating is indicated client-side** — selecting "Compliant" surfaces an inline
  evidence-required warning, so the server's hard gate isn't the user's first hint that an
  attachment is needed. The server check remains the actual enforcement point.
- **Recurrence and re-attestation are wired**: `recurrence` is a form field (empty maps to
  one-time), `next_review_date` renders read-only on obligations that have a cadence — matching
  its derived-not-client-settable status server-side — and re-attestation history is reachable
  from the obligation row.
- **Dates render as calendar dates, not instants.** Due date and next-review date go through a
  UTC-safe date-only formatter. A bare `YYYY-MM-DD` parses as UTC midnight, so formatting it in
  local time showed the day before for every user west of UTC — an obligation due the 1st read as
  due the 31st (#244). Any new date-only field on this page needs the same helper; the ordinary
  date formatter reintroduces the bug.
- **Deleting the last row on a filtered page doesn't strand the user** — the page index is
  clamped to the new total via the shared `useClampPageToTotal` hook, rather than leaving an
  out-of-range empty page with no way back (#265; the same hook covers Templates, Inspections,
  Sites, Findings and Audit).
- **`line_of_defense`** — same governance-board-only pattern as Risk/KRI.
