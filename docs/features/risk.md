# Risk register

The flagship module. A `Risk` is a risk-register entry (`ref`, e.g. `CYB-001`; `name`;
`category`; scores; tied to a `Site`) with several distinct workflows layered on top of it.

## Reference codes

Server-generated, never client-supplied (`risk_ref.ts`). Prefix derived from `category` via
`RISK_CATEGORY_PREFIX_MAP` (cyber→CYB, financial→FIN, etc., falling back to first-3-letters or
"GEN"). The numeric sequence is scoped per `(org_account_id, prefix)`. Concurrency is handled by
retrying the whole create (or whole transaction, via `retryTransactionOnRefConflict`) on a P2002
unique-constraint conflict, rather than locking.

## Inherent / residual scoring — derive-with-override-and-staleness

Both scores follow the same pattern (aexa-server#241/#247), mirroring how ServiceNow IRM
actually behaves:

- **`inherent_score`** is derived by default from `probability × impact` when both are known
  (`risk_scoring.ts`'s `computeInherentScore`). Falls back to whatever raw value is supplied
  when probability/impact aren't both present — the AI-onboarding and intelligence-promotion
  producers don't collect a real `impact` yet, so derivation is a no-op there.
- **`residual_score`** is derived from `inherent_score` plus `control_design_eff` and
  `control_operating_eff`.
- Both can be manually overridden (`inherent_is_override` / `residual_is_override`), but an
  override **requires a reason** (`*_override_reason`) and records who/when
  (`*_overridden_by`/`*_overridden_at`).
- If an underlying input changes after an override was set, the override is marked **stale**
  (`*_override_stale = true`) rather than silently discarded or silently kept — it needs
  re-confirmation.
- `impact` (0–100, added in #241) is a real, separately-collected measurement — before this, the
  risk matrix's likelihood×impact axes weren't actually independent ("impact" was faked from
  `inherent_score`). It is deliberately *not* wired back into `inherent_score`'s own value.

**Every AI-derived producer clamps before writing.** The 0–100 percent columns are populated by
three paths — manual entry, intelligence promotion, and the onboarding wizard — and the latter
two take their number from an LLM, which is under no obligation to respect the range. Both route
through `clampPercent` (`risk_scoring.ts`, the same helper the derivation formulas use):
intelligence promotion clamps the `probability` it derives from an item's `relevance_score`
(#292), and the onboarding AI-risk-draft path clamps `inherent_score` (#296, with a matching
bound in `onboarding.validation.ts` so an out-of-range score can't get in even if it bypasses
the service-level clamp). Previously an out-of-range AI value went straight into the column and
silently corrupted every score derived from it, plus the risk's matrix position.

## Maker-checker approval workflow (`risk.approval.service.ts`, #95)

A **separate concept** from the plain `Risk.status` operational-lifecycle string.
`RiskApproval` state machine: `PENDING_APPROVAL → APPROVED | REJECTED`, plus `invalidatedAt`
(soft-supersede).

- LEAD_AUDITOR or ADMIN submits a risk's current assessment for approval.
- ADMIN approves or rejects.
- **The submitter can never be the approver** — even in a solo-admin org. This is documented as
  intended, not a gap to fix: an org with exactly one admin has no one who can approve a risk
  that admin submitted.
- Editing a risk with a live (`PENDING_APPROVAL`/`APPROVED`, non-invalidated) approval cycle
  invalidates it atomically in the same DB transaction as the edit (#203), forcing a fresh
  submission.
- A `REJECTED` or invalidated cycle never blocks a fresh submission — enforced by a partial
  unique index ("one live cycle per risk").
- Permission: submit via write-role check; approve/reject via `assertIsOrgAdmin`.

## Delete guard

A risk cannot be deleted while any Inspection, Recommendation, KRI, live approval cycle, or
`AuditEngagementRisk` link still references it — returns 409 with a count breakdown.

## Risk-to-risk correlation (`risk_link` module)

`RiskLink` rows reference risks **by `ref` string**, not by FK/UUID — deliberately, so links
stay human-legible ("CYB-001 CAUSES OPS-004" reads straight out of an export) and portable
across a risk being recreated/re-imported with a new id but the same ref. The tradeoff (no real
FK enforcement) is paid for with application-level validation: both `source_ref`/`target_ref`
must resolve to a real, org-scoped Risk row at write time.

`link_type` ∈ `CAUSES | AMPLIFIES | CORRELATES`.

`GET /risk/correlation-matrix` returns raw risks/links/actions for client-side bucketing — no
server-side graph computation. Because the bucketing is client-side, the matrix page's
selected-cell state is reset whenever the matrix's shape changes (a site filter or a
matrix-size change): a cell selected under the old grid can point at coordinates that no longer
exist, which previously rendered the detail panel's un-interpolated i18n placeholder text
(literal `{{rootCause}}`) instead of a clean empty state (#257).

## AI root-cause bucketing

`POST /risk/root-cause-bucketing` calls aexa-ai to cluster risks/findings into root-cause
buckets. `POST /risk/create-action` ("Send to Finding") converts one bucket's `groupedAction`
into a real `Action`, using a lazily-created, reused synthetic Template+Inspection per org —
because `Action.inspectionId` is required but a bucket can span multiple risks/sites with no
single real inspection to attach to. "Send to Finding" invalidates `CORRELATION_MATRIX` on the
client: the matrix renders actions alongside risks and links, so a newly created finding
otherwise stayed invisible on the page that just created it (#261).

## Three Lines of Defense classification

`line_of_defense` (#97) defaults to `FIRST` (operational/management-owned), matching the
Fullbloom reference's per-entity-type default. `GOVERNING_BODY` was added later
(aexa-frontend#208) as an explicit fourth value for items that genuinely sit at board-level
oversight (e.g. a risk formally accepted by the board) — no existing default changed.

## Permissions summary

| Action | Gate |
|---|---|
| Create / update / delete | `assertCanWriteOrgResource` (ADMIN/LEAD_AUDITOR) |
| Submit for approval | `assertCanWriteOrgResource` |
| Approve / reject | `assertIsOrgAdmin` |
| Reassign `line_of_defense` | `assertCanReassignLineOfDefense` (stricter than a plain field update) |

## Frontend wiring (aexa-frontend)

- **Core CRUD + raw scores**: fully wired (Risk Register page) — plain numeric inputs for
  `inherent_score`/`residual_score`/`pagerank_score`, financial impact, probability, velocity,
  trend, control effectiveness.
- **Override + staleness — wired (aexa-frontend#269).** The frontend's `Risk` type now carries
  all ten override/staleness/audit fields. The create/edit form has a per-score override toggle
  (inherent and residual) with a React Hook Form `validate` rule making the reason **required
  only while that toggle is on**, mirroring `risk_scoring.ts`'s own conditional requirement.
  `RiskOverrideBadge` renders next to a score in one of two states — amber "stale" and blue
  "overridden" — and renders **nothing** when that score isn't overridden, so the common case
  stays uncluttered. Both scores get a badge inside the form on **edit** (they're behind `editId`,
since a brand-new risk has no override to describe); the register **list**
  carries only the residual one, because residual is the only score with a column of its own
  there. Adding an inherent column later means adding its badge too. `overriddenBy` is shown as a raw
  accountId; there's no endpoint to resolve one to a display name from this frontend (the same
  constraint `attested_by` already lives with).
- **The override keys are only sent when the user actually touched that control.** Worth
  knowing before editing `onSubmit` in `RiskRegisterPage.tsx`, because the naive reading is
  wrong: the form pre-populates both toggles from the stored row, so submitting their current
  value on *every* save would make an edit to an unrelated field (a rename, say) look like a
  fresh override to the server. `resolveInherentFields`/`resolveResidualFields` treat an
  **omitted** `*_override` key as "no instruction, preserve what's there" but an **explicit
  `true`** as "fresh override — reset `*_overridden_by`/`*_overridden_at` to now, clear
  `*_override_stale`." So each score's `*_override`/`*_override_reason` pair is gated on
  `formState.dirtyFields` (its toggle, its reason, or its score being dirty) and deleted from the
  payload otherwise. That's what keeps an untouched override's audit trail and its unreviewed
  staleness flag intact through unrelated edits. The server-derived
  `*_overridden_by`/`*_overridden_at`/`*_override_stale` fields are never sent at all.
- **Maker-checker approval** — fully wired, including a client-side self-approval guard, a
  reject-reason modal, and a "pending my approval" filter.
- **RiskLink correlation + correlation matrix + PageRank graph** — fully wired, including
  client-side PageRank computation over the correlation edges (see
  [frontend-overview.md](frontend-overview.md) — distinct from the manually-entered
  `pagerank_score` field).
- **AI root-cause bucketing + "send to finding"** — fully wired, gated to ADMIN/LEAD_AUDITOR.
- **`line_of_defense`** — wired only through the Three Lines of Defense board, not editable from
  the Risk's own create/edit form. All four values including `GOVERNING_BODY` are supported (see
  [governance-audit.md](governance-audit.md)).
- **Financial-impact figures are in raw currency units and rendered as millions** — Risk
  Register, the PageRank graph's detail panel, and the correlation matrix's bucket totals all
  divide `financial_impact_max` by 1,000,000 for their `M` labels. Three of these divided by
  1,000 while still labeling the result "M", overstating every figure by 1000× (#236). Worth
  knowing before adding a fourth display site: the stored column is not pre-scaled.
- **Create/update/delete invalidate `CORRELATION_MATRIX` as well as `RISK`.** The correlation
  matrix and PageRank graph derive from the same risk set, so a risk edited from the register
  used to leave both showing pre-edit data until an unrelated refetch (#261).
