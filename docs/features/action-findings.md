# Findings / Actions

`Action` is the corrective-action / audit-finding record, attached to an Inspection (and
optionally a `Question` or `ComplianceObligation`, or an `AuditEngagement`). The most heavily
role-gated module besides Risk.

## Five Cs (#244)

IIA's "Five Cs" for a defensible finding record: Criteria, Condition, Cause, Consequence
(Effect), Corrective Action. `actionTitle`/`actionDisc`/`priority`/`dueDate` already served as
the Corrective Action; `criteria`/`condition`/`cause`/`effect` were added on top — all nullable/
optional (existing rows, and plenty of legitimate Actions are still plain remediation tasks, not
formal audit findings, so nothing is forced to classify).

## Line of Defense classification (#97)

Deliberately **nullable with no default** — the one exception among the five models this
classification touches (Risk/Kri/Compliance/AuditEngagement all get a sensible default). An
Action covers two very different roles (1st-line-like remediation vs. 3rd-line-like audit
finding), so any single default would misclassify roughly half. Existing rows stay `NULL`
("Unclassified" in the UI); `create_action`'s validation schema makes it **required** for any
new Action going forward, while `update_action` keeps it optional. Reassigning it on an existing
Action requires the stricter `assertCanReassignLineOfDefense` gate even though ordinary field
edits only require `assertCanWriteToAction`.

## Sub-assignment system — `FindingAssignment` (#55 slice 4/5)

A Lead Auditor/Admin can sub-assign one specific finding to a `LIGHT_USER` (internal `OrgMember`
or external `ExternalOrgMember`).

- If the org has `requireApprovalForSubAssignment` enabled, the assignment starts
  `PENDING_APPROVAL` and an Admin must approve it; otherwise it starts `ACTIVE` immediately.
- Only `ACTIVE` + non-revoked grants real access (`getAssignedActionIds`).
- Approve/reject re-check `revokedAt` to avoid corrupting the audit trail if the request was
  withdrawn mid-flight.
- `responsibleAssignees` (`ActionResponsible`) is a **separate, non-authority** concept — a
  plain informational "who's nominally responsible" tag any member can set, deliberately not
  conflated with the real access grant a `FindingAssignment` represents.

## Finding closure — maker-checker (#252)

A finding only ever reaches a terminal status (`COMPLETE` or `CANT_DO`) via an **approved
closure request** — a direct `PATCH /action/:id` setting either status is rejected with 400.

Endpoints:
- `POST /api/action/:id/closure/submit` — requests a terminal status. Requires at least one
  attachment already on the finding. Does not itself change status.
- `GET /api/action/:id/closure` — current closure state.
- `POST /api/action/closure/:id/approve` — ADMIN/LEAD_AUDITOR only, never the same person who
  submitted. Atomically applies the requested status to the finding.
- `POST /api/action/closure/:id/reject` — same role/self-check, requires a `decisionNote`. The
  finding is left untouched (it never advanced while pending).

`ActionClosureApproval` state machine mirrors `RiskApproval`: `PENDING_APPROVAL → APPROVED |
REJECTED`, plus `invalidatedAt` soft-supersede. A partial unique index enforces "at most one live
(non-invalidated, non-rejected) cycle per finding." Editing the finding while a cycle is live
invalidates it (`invalidateLiveClosureApprovalsOnEdit`), forcing resubmission — including on the
external-member edit path, which resolves the real `Organization.id` via `externalMember.orgId`
(not `.organizationId` — see [cross-cutting.md](cross-cutting.md) for why that distinction
matters).

## Read scoping — `applyActionScope` and the model being filtered

Read scoping for a Light User can't be expressed as one fixed column, because the grant is
always a `FindingAssignment` on an **Action** while the row being filtered often isn't one. So
`applyActionScope` takes an `idField`:

- `'id'` (the default) — filtering Actions themselves. Restricts `id` to `getAssignedActionIds`.
- `'inspectionId'` — filtering rows that hang off an assigned Action's *inspection*, namely Note
  and Recommendation. Restricts `inspectionId` to `getAssignedActionInspectionIds`, which
  resolves a Light User's assigned actions through to the inspections those actions belong to.

Worth stating explicitly because getting it wrong fails **silently and closed**: the LIGHT_USER
branch previously filtered Note and Recommendation by Action id regardless of model, and since
no Note or Recommendation id is ever an Action id, every such query matched nothing. A Light
User saw no notes and no recommendations at all, with no error to explain why (#280). Any new
model brought under this helper needs its own correct field, not the default.

## `MessageVisibility`

`INTERNAL` / `CLIENT_VISIBLE` enum exists on the schema today with **no enforcement yet** — a
known gap, not a released feature.

## IDOR hardening

`questionId`, `complianceObligationId`, and every `assignBy` id are verified to belong to the
caller's own org before being attached to an Action.

## Permissions summary

| Action | Gate |
|---|---|
| Create / update (ordinary fields) | `assertCanWriteToAction` (assignee-aware for Light Users) |
| Reassign `line_of_defense` | `assertCanReassignLineOfDefense` |
| Sub-assign to a Light User | write-role check; approval required only if org setting is on |
| Approve/reject a sub-assignment | ADMIN |
| Submit for closure | anyone who can write to the finding |
| Approve/reject closure | ADMIN/LEAD_AUDITOR, never the submitter |

## Frontend wiring (aexa-frontend)

- Core CRUD is wired (create/edit modal, findings list, finding detail view), with write
  affordances gated to ADMIN/LEAD_AUDITOR — see [frontend-overview.md](frontend-overview.md) for
  what that gate does and doesn't cover.
- **Five Cs are wired** — `criteria`/`condition`/`cause`/`effect` are on the frontend's `IAction`
  type and render in the finding detail view. Consistent with the fields being optional
  server-side, the block only appears when at least one of the four is set, so a plain
  remediation task doesn't grow an empty "audit finding" section it was never meant to fill in.
- **Finding closure maker-checker is wired** (`FindingClosureControls`), following
  `RiskApprovalControls`' pattern: a badge per `ClosureDisplayState`
  (`NOT_SUBMITTED`/`PENDING_APPROVAL`/`APPROVED`/`REJECTED`) plus submit/approve/reject actions
  role-gated and self-approval-guarded on the client, with the server re-checking both.
- **Finding due dates round-trip correctly.** The `datetime-local` input is serialized through a
  shared helper in `dueDateInput.ts` rather than raw string slicing, which was shifting the
  stored date by up to a day depending on the viewer's UTC offset (#238).
- **`addFindingMessage` is wired** — the Messages tab has a compose box, and the mutation's
  `invalidatesTags` refreshes the thread rather than the component patching local state.
- **`FindingAssignment` sub-assignment — still absent as a distinct concept.** There's a generic
  `assignBy` multi-select (any org member, no internal/external Light-User distinction, no
  approval flow), and the detail page's "Assigned Users" panel does now render it (#215 — it
  previously always showed the empty state without ever reading the list). The real grant
  mechanism — who actually gains write access to a finding, and
  the admin approval step when `requireApprovalForSubAssignment` is on — has no UI, so the whole
  sub-assignment workflow is reachable only through the API today. This is also why client-side
  gating can't narrow a Light User to their assigned findings; see
  [frontend-overview.md](frontend-overview.md).
- **`line_of_defense`** — same governance-board-only pattern as the other four entities.
