# Governance board & audit engagements

## Three Lines of Defense board (`governance` module, #97)

A single read endpoint fanning out across Risk / Action / Kri / ComplianceObligation /
AuditEngagement and returning them as one combined, org-scoped, `line_of_defense`-classified
payload. The Fullbloom reference splits this into 6 tables; here it's 5, since Action already
covers both mitigations and findings.

`line_of_defense` (`LineOfDefense` enum: `FIRST | SECOND | THIRD | GOVERNING_BODY`) defaults per
entity type — see each module's doc for its specific default. `GOVERNING_BODY` (added in
aexa-frontend#208) is the 2020 IIA Three Lines Model's headline addition over the 2013 version
this system originally modeled: an explicit governing body sitting above the three lines, for
items that genuinely sit at board-level oversight (e.g. a board-mandated audit engagement, or a
risk formally accepted by the board).

The board's Action fan-out goes through `applyActionScope`, so a scoped Lead Auditor or Viewer
sees only the findings their assignments cover rather than the whole org's — the same read-side
rule the Findings list and report generation apply (see
[action-findings.md](action-findings.md)). The other four entities are plain org-scoped reads.

Reassigning `line_of_defense` on any of the five entities is gated by the stricter
`assertCanReassignLineOfDefense` (the "third-line-independence" permission fix from the same
ticket) — not the entity's ordinary write-role check.

## Audit engagements (`audit` module)

`AuditEngagement` — an internal-audit engagement (`ref`, `title`, `scope`, `lead_auditor`,
`findings_count`, `report_url`), linked to the `Risk`s it covers via an explicit join table
`AuditEngagementRisk` (aexa-frontend#165) rather than a free-text tag column.

- **Asymmetric delete guard**: deleting an engagement legitimately cascades away just its own
  link rows (the risks it covered survive). But a **Risk still linked to any engagement is
  blocked from deletion** (enforced in `risk.service.ts`) — the audit↔risk link is meaningful
  audit-trail data that must not silently vanish.
- Defaults to `line_of_defense: THIRD`.
- Write actions gated by `assertCanWriteOrgResource`.

## Frontend wiring (aexa-frontend)

- **Governance board** — fully wired: one cross-entity board (risks/actions/KRIs/compliance
  obligations/audit engagements) bucketed by line, with reassignment buttons gated to
  ADMIN/LEAD_AUDITOR, and an "Unclassified" bucket surfacing pre-#97 Actions with a null
  `line_of_defense`. This is the **only** place any of the five entities' `line_of_defense` can
  actually be changed from the UI.
- **All four lines render**, `GOVERNING_BODY` included, as a fourth column with its own
  move-to action (aexa-frontend#208/#209). The classification is usable end-to-end.
- Reassignment reuses each entity's own update mutation rather than a dedicated governance
  endpoint — so `assertCanReassignLineOfDefense` on those mutations is what actually enforces
  third-line independence; the client-side role check is the usual convenience layer.
- **Audit engagements** — CRUD + risk-linking (`AuditEngagementRisk`, via a risk multi-select
  component) are fully wired.
