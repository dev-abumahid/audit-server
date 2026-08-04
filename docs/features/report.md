# Reports

`Report` — an AI-generated, human-reviewed board risk report. Content generation delegates to
aexa-ai's `POST /report_content` (see [ai-service.md](ai-service.md)) — a single `gpt-4o`
JSON-mode call with hand-written "use only the data you're given, never fabricate" instructions
and full response normalization on the aexa-ai side.

## State machine

`GENERATING → READY` (AI + PDF succeeded, awaiting review) `→ PUBLISHED` (final/citable), or
`→ FAILED`. Only `READY → PUBLISHED` is a legal transition, and publishing is ADMIN-only
(`assertIsOrgAdmin`).

## Per-org concurrency guard

Refuses a new `generate` while one is already `GENERATING` for that org — each launches a
~300MB headless Chromium render, a real OOM risk if allowed to stack up.

## Stale-row reaper

Any `GENERATING` row untouched past route-timeout+5min grace is opportunistically swept to
`FAILED` on the next list read. No cron infra needed for this.

## Risk-approval integration

Excludes only live-REJECTED risks from the report; every included risk is annotated with its
live approval-state label post-generation (joined by a stable `ref`, since aexa-ai's schema
forbids unknown fields on the risk input it consumes). Deliberately **does not** hard-gate on
`APPROVED` — most risks never enter the maker-checker workflow at all, so requiring it would
exclude the majority of real risk data from every report.

## Read/write scoping — and one open question

**Generation is role-scoped.** The Action query behind report generation runs through
`applyActionScope`, matching every other Action aggregate call site (the Three Lines board, the
Findings list, the correlation matrix). `assertCanWriteOrgResource` lets a `LEAD_AUDITOR`
generate a report, and without that filter the report pulled every open Action in the org rather
than only those from their assigned inspections — pushing org-wide finding data into a document
they don't otherwise have full visibility into (#289). Publishing stays ADMIN-only.

**Reading is not role-scoped, and whether it should be is undecided.** `GET /report`,
`GET /report/:id` and the download route are gated on account type alone, so any org member —
`VIEWER` and `LIGHT_USER` included — can list and download every generated board report,
including ones assembled from findings they can't see individually. This was left open rather
than hardened alongside #289: a published board risk report is plausibly _meant_ to be
org-wide-readable, which makes tightening it a product decision about what a report is for,
not a straightforward fix. It needs a call either way — see [README.md](README.md)'s known-gaps
list.

## Signed download URLs

`file_url` is never handed back raw — a short-lived (5 minute) signed Cloudinary URL is minted
per download request, so a leaked link expires quickly. Note this is a leak-window control, not
an authorization control: the gate on who may request one is the read gate discussed above.
