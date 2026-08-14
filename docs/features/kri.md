# KRIs (Key Risk Indicators)

A `Kri` always belongs to a parent `Risk` — never standalone. `current_value`, `alert_threshold`,
`target_value`, optional `frequency` (e.g. "monthly"), optional `owner` (free-text name of who's
responsible for this KRI — same convention as `ComplianceObligation.owner`/`AuditEngagement.owner`,
not an `OrgMember`/`Account` FK).

## Derived status

`OK` / `WARNING` / `ALERT`, computed on read (`compute_kri_status`), never stored. Direction
(higher-is-better vs. lower-is-better) is _inferred_ from whether `target_value` is above or
below `alert_threshold` — validation rejects the two being equal so direction is never
ambiguous.

## Threshold-breach alerting (#242)

`submit_kri_value_into_db` fires a new `Alert` row only on the **transition into** ALERT, not on
every submission while already breached. Guarded by optimistic concurrency keyed on `updatedAt`
(not `current_value` — two submissions of the identical value would otherwise both slip through
a value-keyed guard).

## Trend history (#242)

`KriReading` is an append-only history of every value a KRI has ever been recorded at (never
updated or deleted — a submitted reading is a historical fact, same precedent as `RiskApproval`/
`OrgAuditLog`). `GET /api/kri/:id/readings` exposes it. No pruning job. Historical trend
**visualization** (a chart) is an explicit frontend fast-follow — this just makes the data exist
and be queryable.

## Overdue detection (#242)

`last_measured_at` is denormalized onto `Kri` (rather than derived per-row from `KriReading`) so
`get_all_kri_from_db` can compute `overdue` for a page of KRIs without a correlated subquery per
row. Combines with `frequency` via `FREQUENCY_INTERVAL_DAYS` (`kri.service.ts`) to flag a KRI
overdue for its next reading.

## Classification & permissions

Defaults to `line_of_defense: SECOND` (risk/compliance oversight function). Write actions gated
by `assertCanWriteOrgResource` (ADMIN/LEAD_AUDITOR), same as Risk.

## Frontend wiring (aexa-frontend)

- CRUD + current-value submission is wired, with OK/WARNING/ALERT status badges and counts on
  the KRI Dashboard page. Write affordances are gated to ADMIN/LEAD_AUDITOR via
  `canWriteOrgResource` — see [frontend-overview.md](frontend-overview.md).
- **Trend history is wired** — the dashboard reads the paginated `GET /kri/:id/readings` and
  renders the append-only `KriReading` series as a chart. This was the "explicit frontend
  fast-follow" the backend work anticipated; the history is no longer write-only.
- **Overdue is surfaced** as a badge, driven by the server-computed `overdue` flag rather than
  recomputed client-side. It is always `false` for a KRI with no `frequency`, so the badge simply
  never appears on a cadence-less KRI — the derivation being honest about having no cadence to be
  late against, not a missing case.
- **`line_of_defense`** — same pattern as Risk: settable only via the governance board, not the
  KRI create/edit form.
