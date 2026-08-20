# Design Doc: AI-generated risks need a pending-review gate before joining the live register

Status: revised after a 5-angle adversarial review pass, ready for implementation

**Revision note**: a review panel (data-model, backend-completeness, API/security, frontend-UX, edge-cases —
5 independent agents against the v1 draft) found 2 real blocking gaps in each of the API-design and
frontend sections, one missed backend call site, and one missed cross-feature edge case (dismiss has no
in-use guard, unlike delete). All are folded into this revision; see inline notes marked **[review fix]**.

## Problem statement

The site-level "Analyze with AI" feature (`site-ai-risk-register-generation.md`) writes AI-generated risks
directly into the org's confirmed risk register — no staging, no approval step. This was a deliberate
redesign decision (that doc's §9) that removed the prior `AiSuggestionState` suggest/dismiss/import
lifecycle in favor of a one-shot generate-and-commit flow.

Found live-verifying the retry-failed-categories feature (2026-08-20): running AI analysis against a site
with almost no real detail (`"Manufacturing and logistics operations, for live-verification testing."`)
still produced 56 specific-looking risks — financial impact figures, control-effectiveness ratings, risk
codes — with no lower confidence or hedging, because there is no signal distinguishing "thin test
placeholder" from "real company that's light on detail." A parallel multi-agent research pass (design
intent, industry-standard practice, technical feasibility, production-data impact — see session log)
concluded:

- This gap was never deliberately scoped out during the original design — the one validation test used a
  rich, real company profile, so the thin-input failure mode never surfaced.
- No comparable competitor (Drata, LogicGate, Vanta, ServiceNow Now Assist) gates *generation* on input
  richness. The universal pattern is: generate freely, but require an explicit human approval step before
  AI output counts as an official record, plus persistent AI-provenance marking (which this codebase
  already has via `Risk.ai_generation_run_id` and `Risk.citation_confidence`).
- The actual gap, relative to every surveyed competitor, is the missing approval step this doc adds back —
  not a content-richness confidence gate (rejected: non-standard, hard to calibrate, and technically weaker
  than the maker-checker precedent already in this codebase).

## Decisions already confirmed (do not re-litigate)

1. **Dismiss is a soft state, kept for audit history** — not a hard delete. Mirrors the removed
   `AiSuggestionState`'s dismissed-history view, and fits a GRC/audit product where "what was proposed and
   rejected, by whom, when" has standing audit value.
2. **Both bulk and per-risk approve/dismiss are required.** A single AI run can produce 15-60 risks;
   forcing individual review of every one would just get rubber-stamped (the original design doc's §6
   "trust fatigue at volume" concern, never resolved before the suggest/approve model was removed).

## Data model

New Prisma enum + field on `Risk` (`aexa-server/prisma/schema/risk.prisma`):

```prisma
enum RiskReviewStatus {
  APPROVED
  PENDING_REVIEW
  DISMISSED
}
```

```prisma
model Risk {
  // ...existing fields...
  review_status  RiskReviewStatus  @default(APPROVED)
}
```

**Naming note — do not call this `approval_status`.** This codebase already has an unrelated, shipped
maker-checker workflow using that exact vocabulary: `RiskApprovalStatus` enum
(`NOT_SUBMITTED | PENDING_APPROVAL | APPROVED | REJECTED`, `risk.prisma:272`) on the separate `RiskApproval`
model, `risk.approval.service.ts`, `RiskApprovalControls.tsx` on the frontend
(`docs/design-docs/95-risk-approval-workflow.md`). **[review fix]** `Risk.approvalStatus` is not itself a
stored column — it's a virtual property computed at read-time (`risk.service.ts:101`,
`{...risk, approvalStatus: deriveApprovalState(latest)}`) from the related `RiskApproval` row, so the
collision is even further from a schema-level clash than the original draft implied, but the *name* is
still real, shipped, user-facing vocabulary and must stay distinct. That workflow is Lead-Auditor-submits /
Admin-approves-or-rejects sign-off on a risk's *assessment* (is this risk analysis correct and final).
This doc's field is a completely different axis — *does this risk-register entry exist at all yet, or is
it an unreviewed AI suggestion* — and reusing the name would silently collide with real, shipped
functionality throughout both repos (e.g. `report_pdf.ts`'s `ReportTopRisk.approval_status` DTO field).
Field name: `review_status`. Enum: `RiskReviewStatus`.

**[review fix] Index**: add a composite index on `(org_account_id, review_status)` in the same migration —
the register list endpoint and several filtered call sites below will query by it on every load.

**Default and backfill.** New field defaults to `APPROVED`. This applies to the migration backfill too:
every existing row (manually-created risks, and every AI-generated risk from before this feature ships,
including the 56 test rows generated tonight) becomes `APPROVED` on migrate. Retroactively flipping
historical AI risks to `PENDING_REVIEW` would be disruptive and surprising — this gate is for risks
generated *from this point forward*.

**Creation-time behavior.** `persistGeneratedRisk` (`aiRiskAnalysis.service.ts`) sets
`review_status: 'PENDING_REVIEW'` instead of relying on the default, since it always knows it's writing an
AI-generated row. Manually-created risks (`create_risk_into_db`, `risk.service.ts`) don't set the field at
all and get `APPROVED` from the schema default.

## Backend filtering strategy — filter at the source, not at each call site

A full trace of every backend query touching `Risk` (see session log for the complete file:line table)
found ~20 call sites, most of which are either (a) direct lookups by an explicit risk ID from a URL/body,
which should work regardless of review status, or (b) aggregate/list queries that should never surface
`PENDING_REVIEW`/`DISMISSED` risks. A second trace of the frontend found ~10 components that fetch a raw
risk list from the *same two* endpoints (`getAllRisks`, `getCorrelationMatrixData`) and then do their own
client-side aggregation (risk matrix bucketing, PageRank graph layout, dashboard tiles, KRI risk-picker,
CSV export). Patching every one of those client-side aggregations individually is exactly the kind of
scattered-fix surface area that a missed call site turns into a real bug — an unapproved risk quietly
showing up in the risk matrix or graph.

**Design: the two shared backend endpoints default to `APPROVED`-only. Only the Risk Register endpoint gets
an explicit opt-in to see all three statuses.** Every other consumer — matrix, graph, dashboard, KRI
dropdown, CSV export, compliance/audit linking, template generation — needs **zero code changes**, backend
or frontend, and automatically only ever sees approved risk data, because they all ultimately read through
`getAllRisks`/`getCorrelationMatrixData` without passing the opt-in param.

| # | Call site | Treatment |
|---|---|---|
| 1 | `risk.service.ts:65` `get_all_risk_from_db` (register list) | **The one exception.** Add optional `reviewStatus` query param (`"all"` \| omitted). Omitted → `APPROVED`-only (matches every other consumer's expectation, since this same function backs some non-register callers too, per the trace). Register page passes `reviewStatus=all` explicitly and splits the response client-side into Approved / Pending / Dismissed sections. |
| 2 | `risk.correlation.service.ts:46` `get_correlation_matrix_data` (correlation matrix + graph data) | **`APPROVED`-only, no opt-in.** Feeds correlation matrix and page-rank graph — neither should ever show unreviewed risks. |
| 3 | `risk.correlation.service.ts:194` `run_root_cause_bucketing` | Same as #2 — feeds the same pipeline. |
| 4 | `risk.service.ts:504` `get_ebitda_at_risk_summary` | **`APPROVED`-only.** Executive dashboard financial exposure chart shouldn't include unreviewed AI numbers. |
| 5 | `governance.service.ts:69` `get_three_lines_of_defense_from_db` | **`APPROVED`-only.** |
| 6 | `report.service.ts:149` `fetchOrgData` | **`APPROVED`-only.** Board/CSV report export. **[review fix]** The same function also runs `prisma.kri.findMany({include:{risk:{select:{name:true}}}})` (line 154) — a KRI attached to a `PENDING_REVIEW`/`DISMISSED` risk would still surface that risk's name via this join even after the risks section above is filtered. Add a `review_status: 'APPROVED'` condition on the joined `risk` relation here too, not just on the top-level risks query. |
| 7 | `intelligence.service.ts:46` `fetchExistingRisks` (news-to-risk dedup) | **`APPROVED` + `PENDING_REVIEW`** (exclude only `DISMISSED`) — dedup should still catch "we already have this as a pending suggestion," but an explicitly-dismissed suggestion shouldn't block a legitimate future re-flag. |
| 8 | `aiRiskAnalysis.service.ts:262` `fetchExistingRiskTitles` (AI regeneration dedup hint) | Same as #7 — `APPROVED` + `PENDING_REVIEW`. |
| 9 | `risk.service.ts:589` `suggest_risk_fields_with_ai` (calibration context) | **`APPROVED`-only** — don't calibrate new AI suggestions off other not-yet-reviewed AI output. |
| 10 | `aiRiskAnalysis.service.ts:343` `prisma.risk.count({ai_generation_run_id})` ("risks_created" count for a run) | **Unaffected** — intentionally counts everything a run produced, regardless of review status; this reports generation output, not approval state. |
| 11 | `risk.service.ts:114/233/394/414`, `risk.approval.service.ts:37`, `ai.service.ts:224`, `compliance.service.ts:802`, `risk_link.service.ts:19`, `audit.service.ts:93`, `kri.service.ts:146` (explicit-ID lookups/validators), **[review fix]** `risk.correlation.service.ts:402` `assertRiskRefsExist` (missed in the original trace — validates root-cause-bucket `riskRefs` before creating an Action, same shape as `risk_link.service.ts`'s ref check) | **Unaffected.** All operate on an explicit risk ID/ref already known to the caller — filtering these would break legitimate direct access to a specific risk regardless of its review state. |
| 12 | `site.service.ts:140` `prisma.risk.count({site_id})` (site-delete guard) | **Unaffected, deliberately** — must count all statuses, so deleting a site is still blocked by any risk under it, pending or not. |

**Open item flagged, not resolved by this doc:** `risk_link.service.ts:19` `assertRiskRefExists` validates a
ref before creating a `RiskLink`, and doesn't currently check review status. Should linking be blocked for a
`DISMISSED` risk? Leaning yes (a link to something explicitly rejected is probably a mistake), but this is
a small enough edge case to decide during implementation rather than block this doc on.

## New endpoints

Following the existing "action verb, no body" convention (`report.route.ts`'s `PATCH /:id/publish`,
this session's own `POST /ai/risk-analysis-runs/:id/retry`):

- `POST /risk/:id/approve` — `review_status: PENDING_REVIEW → APPROVED`. 404 if not found (org-scoped),
  409 if not currently `PENDING_REVIEW`.
- `POST /risk/:id/dismiss` — `review_status: PENDING_REVIEW → DISMISSED`. Same guards. **[review fix]**
  Before dismissing, check whether the risk is referenced by a KRI, ComplianceObligation, AuditEngagementRisk,
  or RiskLink (the same relations `delete_risk_from_db` already blocks on, `risk.service.ts:442-466`) — unlike
  delete, dismiss doesn't break any FK, so this isn't a hard block, but the response should surface the count
  ("linked to 2 KRIs, 1 audit engagement") so the frontend can warn before confirming, rather than silently
  leaving those surfaces displaying a risk that's now rejected as a register entry with no indication of that.
- `POST /risk/bulk-approve` — body `{ riskIds: string[] }`, validated via `RequestValidator` + a Zod
  array-of-UUID schema (`risk.validation.ts` pattern — the "action verb, no body" precedent above doesn't
  cover body validation, since neither cited precedent takes one). Approves every `PENDING_REVIEW` risk in
  the list that belongs to the caller's org. **[review fix]** Distinguish two different skip reasons rather
  than folding them into one "silently skipped" bucket: an ID that's already `APPROVED`/`DISMISSED` in the
  caller's own org is a normal, expected race (stale UI) and skips silently, same as bulk-delete's existing
  partial-applicability handling in `useRiskBulkActions.ts`; an ID belonging to a **different org** can never
  arise from legitimate client use (IDs only ever come from the caller's own org's risk list) and should be
  rejected with 400 rather than silently absorbed, since silently swallowing it would mask a real bug in the
  calling code. Returns a count of how many were actually changed.
- `POST /risk/bulk-dismiss` — same shape as bulk-approve, same in-use-reference warning as single dismiss
  (aggregated across the batch).

**[review fix] Permission gate**: all four call `assertCanWriteOrgResource(ctx)` (`org_scope.ts:652`) in
addition to `auth('ORGANIZATION')` — exactly like `create_risk_into_db`/`update_risk_into_db`/
`delete_risk_from_db` and this session's own `retry_ai_risk_analysis` already do. Without it, a caller
whose JWT role is `ORGANIZATION` but whose `CallerOrgContext.role` is `VIEWER`/`LIGHT_USER` could approve or
dismiss AI-generated risks, which is exactly the kind of gap the review panel was built to catch.

**[review fix] Race condition**: single and bulk approve/dismiss all use a guarded `updateMany` — 
`updateMany({ where: { id (or id: {in: riskIds}), review_status: 'PENDING_REVIEW' }, data: { review_status: ... } })`,
branching on `count` — instead of a `findFirst`-then-`update` pair. This is the exact TOCTOU bug the
retry-failed-categories endpoint had tonight (`aiRiskAnalysis.service.ts`, fixed in PR #375) before its own
review round caught it; two concurrent requests against the same risk (a bulk-approve racing a single
dismiss, or two overlapping bulk calls) must not both succeed.

All four org-scoped via the caller's `org_account_id` exactly like every other risk mutation in
`risk.service.ts`.

## Frontend

- `types/organization.d.ts`: add `review_status: "APPROVED" | "PENDING_REVIEW" | "DISMISSED"` to the `Risk`
  interface. Distinct from the existing `approvalStatus` field — both will coexist on the same object.
- `risk.api.ts`: `getAllRisks` accepts an optional `reviewStatus` param forwarded to the backend (default
  omitted, matching backend default). New mutations: `approveRisk(id)`, `dismissRisk(id)`,
  `bulkApproveRisks(riskIds)`, `bulkDismissRisks(riskIds)`. **[review fix]** All four invalidate
  `["RISK", "CORRELATION_MATRIX"]`, not just `RISK` — `RiskGraphPage.tsx`/`Overview.tsx`'s tipping-points
  section read via `useGetCorrelationMatrixDataQuery` (`riskLink.api.ts`), which `providesTags:
  ["CORRELATION_MATRIX"]`, a separate tag from `RISK`. `deleteRisk`/`createNewRisk`/`updateRisk` already
  invalidate both tags together for the same reason (`risk.api.ts:82,93,107`) — without matching that here,
  a risk moving `PENDING_REVIEW → APPROVED` would correctly appear in the register but the graph/correlation
  matrix would stay stale until a hard reload, silently breaking the "zero frontend changes needed" claim
  for those two views specifically.
- `RiskRegisterPage.tsx`: passes `reviewStatus=all`, splits `visibleRisks` into an **Approved** section
  (default register view), a **Pending AI Review** section (per-risk Approve/Dismiss buttons + a bulk
  action bar reusing the existing `useRiskBulkActions.ts` selection scaffold), and a collapsed **Dismissed**
  history view. **[review fix]** This page already has an unrelated "Pending" concept for the maker-checker
  workflow — a `pendingApprovalOnly` toggle (`:385-387`) with a `Clock` icon and "filterPendingApproval"
  label, plus a per-row `RiskApprovalControls` component (`:309`) for submitting a risk for
  Admin sign-off. Reusing the same toggle *pattern* and near-identical visual language
  (clock icon, "pending", approve/reject buttons) for a second, unrelated meaning would reintroduce a
  UI-level collision even though the underlying data model avoids one. Two mitigations: (a) give the new
  section clearly distinct copy and iconography ("Pending AI Review" with e.g. a `Sparkles`/`Bot` icon,
  not `Clock`) so the two "pending" concepts read as visually different at a glance; (b) gate
  `RiskApprovalControls`'s submit-for-approval action on `review_status === "APPROVED"` — a risk that
  hasn't even been confirmed as a real register entry yet shouldn't be submittable into the *separate*
  maker-checker sign-off flow. This also structurally prevents a risk from ever showing both "pending"
  badges at once, since it can't enter the maker-checker flow until it's left `PENDING_REVIEW`.
- **[review fix]** Sort/badge the Pending AI Review section by `citation_confidence` (already a populated
  field on `Risk`) — e.g. `none`/`ai_estimate` rows surfaced above `curated_verified` ones — since that's
  the field most predictive of which pending risks need the closest scrutiny, and the doc's first draft
  didn't use it for review prioritization at all despite it already existing for exactly this purpose.
- `RiskMatrixPage.tsx`, `RiskGraphPage.tsx`, `Overview.tsx` (tipping points, active-risk count, category
  pie), `useKriData.ts` (risk picker), `useRiskCsvExport.ts`, `ComplianceRiskLinkModal.tsx`, `AuditPage.tsx`,
  `CreateTemplateWithAIDialog.tsx` — **no code changes required**, per the filter-at-the-source design
  above. Confirm during implementation that this actually holds (i.e. none of them pass an explicit
  status override that would defeat the backend default).
- `SitesEntities.tsx`: repurpose the existing "AI-flagged risks" tile (currently
  `.filter(r => r.ai_generated).length`, counting AI-origin risks regardless of status) to instead count
  `.filter(r => r.review_status === "PENDING_REVIEW").length` — turns a static label into an actionable
  "needs your attention" badge. Flagged as a UX call being made in this doc, not yet separately confirmed
  with the product owner.

## Migration/rollout sequencing

1. **aexa-server**: Prisma migration (enum + field + backfill), `persistGeneratedRisk` sets
   `PENDING_REVIEW`, backend filtering added to the 8 call sites in the table above, new approve/dismiss +
   bulk endpoints/routes/validation, tests.
2. **aexa-frontend** (depends on 1 being live): type update, API layer changes, Register page UI split,
   `SitesEntities` widget change, tests, live browser verification.

## Resolved by review panel

- Enum needs only 3 states — no real case for a 4th surfaced.
- Missing permission gate, missing race-condition guard, missing cache-tag invalidation, missing dismiss
  in-use warning, missed `assertRiskRefsExist` call site, UI-level "pending" collision — all folded into
  the sections above.
- `SitesEntities.tsx` widget repurposing confirmed clean — `ai_generated` is used in exactly two places
  (the summary tile and a per-risk source badge); only the tile changes.

## Remaining open items (non-blocking, decide during implementation)

1. `risk_link.service.ts`'s dismissed-risk-linking question — should creating a `RiskLink` to an already-
   `DISMISSED` risk be blocked? Leaning yes, small enough to decide inline.
2. Should `bulk-approve`/`bulk-dismiss` be scoped to "all pending risks from one AI run" as a first-class
   action (in addition to arbitrary multi-select), given that's the most common real trigger for wanting
   bulk action at all?
3. **Accepted tradeoff, not a gap to fix**: dedup (table rows #7/#8) excludes only `DISMISSED` titles, not
   `PENDING_REVIEW`. This means a risk a reviewer explicitly dismissed *can* resurface as a new
   `PENDING_REVIEW` duplicate on a later full "Analyze with AI" re-run of the same site (not on a
   *retry*-of-failed-categories, which only reprocesses categories that errored, never ones that succeeded
   and were later dismissed — verified against `retryFailedCategories`'s actual category-selection logic).
   Rationale for keeping this behavior: a dismissal reflects one AI attempt's specific proposal being wrong
   or premature, not a permanent "never applicable" verdict — the alternative (permanently suppressing
   dismissed titles) risks silently hiding a risk that becomes newly relevant later. Documented here so it's
   a known, intentional choice rather than a surprise.
