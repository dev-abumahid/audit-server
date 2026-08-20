# Design Doc: aexa-frontend#95 — Risk approval workflow (Analyst → Manager → CRO) has no equivalent

Status: draft for review, design-only, no code changes made

## Problem Statement

`Risk.status` (`aexa-server/prisma/schema/risk.prisma:16`) is a freeform `String`. The risk route file confirms the ticket's claim directly:

```
router.patch('/:id', auth('ORGANIZATION'), RequestValidator(risk_validations.update_risk), risk_controller.update_risk);
```

(`aexa-server/src/app/modules/risk/risk.route.ts:17-22`)

`auth('ORGANIZATION')` only checks that the caller has an `Account.role` of `ORGANIZATION` (the account-tier role, distinct from the org-tier `OrgRole` enum from issue #55). There is no `OrgRole` check anywhere in the risk module — no `ADMIN`/`LEAD_AUDITOR` gate, no status-transition table, no audit record. Any org member who can hit `PATCH /risk/:id` can set `status` to any string, including flipping a rejected risk back to "approved" with no trace of who did it or why. The frontend reinforces this: `RiskRegisterPage.tsx`'s edit form (lines 503-514) renders `status` as a plain `<select>` — `open` / `in_progress` / `completed` / `closed` — with no separate approve/reject/escalate action, no role check on who sees the field, and no distinction between "draft" and "in force."

Fullbloom has a dedicated `ApprovalQueuePage.tsx` implying a three-role chain (Analyst → Manager → CRO) that does not exist in Qiyrix's actual role model. This doc answers: does Qiyrix want a formal approval chain at all, and if so, mapped onto which real roles.

## Research Findings

### Fullbloom precedent (`github.com/YouYouLux/full-bloom-app`, `src/features/approvals/pages/ApprovalQueuePage.tsx`)

Read in full via `gh api`. Findings:

- UI mechanics worth borrowing: four tabs (En attente / Approuvés / Escaladés / Tous) driven by client-side filters over one `risks` array, stat tiles per tab, a risk card with Approve/Escalate/Reject buttons shown only when `status` is `pending_approval` or `draft`.
- The mechanics are considerably weaker than they look. `handleDecision` (lines 34-47) calls `updateRisk(riskId, { status: newStatus })` directly — the same generic risk-update call the register page uses, not a dedicated approve/reject/escalate endpoint. There is no server-side role check visible in this file (any authenticated user who can load the page can click any button), no audit-trail write, and no distinction between "who is Analyst vs Manager vs CRO" enforced anywhere in code — the roles are asserted only in the page's subtitle string ("Workflow d'approbation des risques — Analyst → Manager → CRO"), not in a permission gate. Escalation has no destination, deadline, or notification; it's just another status value.
- Conclusion: Fullbloom is a useful reference for approval-queue *UI layout*, not for governance *mechanics*. Its "workflow" is cosmetic — closer to what issue #95 is flagging as the current Qiyrix gap than to a real maker-checker control. Copying it as-is would reproduce the same problem with better CSS.

### CDC master spec precedent (`/tmp/cdc-spec.txt`)

Two structurally different precedents in the same document, and they point in different directions:

- **§7.2 Risk Register** (line ~1249): `Statuts : draft → review → approved → active. Notifications email/Slack aux responsables. Signature électronique via Clerk.` via `POST /api/v1/risks/:id/approve`. This is closer to what #95 is asking for shape-wise (explicit approval endpoint, linear state progression) but its confirmation mechanism is Clerk e-signature, which is explicitly rejected for this codebase (platform has its own auth, no Clerk dependency). The RBAC table at line ~1588-1618 (`executive`, `risk_manager`, `cae`, `compliance_officer`, `risk_owner`, `read_only` scopes) also does not map onto Qiyrix's real four-role model and is not usable verbatim.
- **§7.5 Audit Interne, `management_response workflow`** (line ~1334): `finding → notification propriétaire → délai réponse 10j → relance automatique → escalade CAE → rapport final`. This is a better structural template for what a *real* GRC escalation chain looks like: role-based ownership, a deadline, automatic reminders, and a defined escalation destination when the deadline lapses — not just a status value with no timing semantics. It also matches how real maker-checker tools model escalation (see External Research below): escalation-on-timeout, not escalation-on-click.
- API convention note (§8.2, line ~1426-1430): `PUT /api/v1/risks/:id` takes `Body: champs modifiés + version (optimistic lock)`. Relevant here because once a formal approval gate exists, concurrent edits during a pending approval become a real correctness question (see Data Model below).
- This doc borrows the *escalation-with-deadline* shape from §7.5, not the *Clerk-signed linear approval* shape from §7.2, and drops the RBAC role names from §9.2 entirely in favor of Qiyrix's real `OrgRole` enum.

### External research: maker-checker patterns in production GRC tools

- **ServiceNow GRC**: risk workflows are built on ServiceNow's Flow Designer / Workflow engine — dynamic workflows triggered by risk-threshold breach or control failure, which assign responsibility and track remediation, with AI-recommended "smart approvals." Role-based access control gates who can act at each stage. (servicenow.com/products/risk-management.html; community.servicenow.com "GRC Roles & Workflow" thread — confirms roles and workflow stages are configured per-org, not hardcoded to a fixed 3-tier chain.)
- **Archer (RSA/SecurityScorecard)**: RCSA (Risk & Control Self-Assessment) workflow is explicitly maker-checker: a risk manager creates and assigns an RCSA, an assessor reviews/reassesses and submits, then a *separate* risk team reviews for consistency/quality and either returns it with questions or approves it, at which point status becomes "active" and a snapshot is captured. Key point directly relevant to this design: **Archer lets each org model its own tiering/escalation criteria instead of conforming to a vendor-fixed role chain** — i.e., a fixed Analyst→Manager→CRO ladder is itself a design choice Archer deliberately avoids baking in. (help.archerirm.cloud/archersolutions risk_management.htm; trustero.com/resources/blog/archer-grc)
- **General workflow-engine design literature**: for approval workflows specifically, the consensus across sources (Camunda forum, Cflow, several state-machine writeups) is: model explicit states with an explicit transition table (not booleans scattered through code); a plain status enum + backend-enforced transition table is sufficient until you have *multiple, structurally different* approval flows in the same system — at that point a generic reusable engine starts paying for itself. One risk workflow does not meet that bar.

Sources: [servicenow.com/products/risk-management](https://www.servicenow.com/products/risk-management.html), [ServiceNow Community — GRC Roles & Workflow](https://www.servicenow.com/community/grc-forum/grc-roles-workflow/m-p/1304810), [Archer Risk Management Solution](https://help.archerirm.cloud/archersolutions/en-us/Content/ArcherSolutions/risk_management.htm), [Trustero — Archer GRC Tool Guide](https://trustero.com/resources/blog/archer-grc), [Cflow — Approval Workflow Design Patterns](https://www.cflowapps.com/approval-workflow-design-patterns/), [workflowengine.io — Workflow Engine vs. State Machine](https://workflowengine.io/blog/workflow-engine-vs-state-machine/).

### The existing in-house precedent (the strongest source of all)

Qiyrix already shipped a real maker-checker pattern in slice 4 of issue #55: `FindingAssignment` (`aexa-server/prisma/schema/organization.schema.prisma:114-143`).

- Enum: `FindingAssignmentStatus { PENDING_APPROVAL, ACTIVE, REJECTED }`.
- Org-level toggle: `Organization.requireApprovalForSubAssignment` (default `false`) — if off, a sub-assignment goes straight to `ACTIVE`; if on, it starts `PENDING_APPROVAL` and needs an Admin to approve it (`action.service.ts:445`, `approve_finding_assignment` at `action.service.ts:615-651`).
- Approval is **admin-only**, enforced server-side via `assertIsOrgAdmin(ctx)`, not a client-side button gate.
- Every approval/rejection writes an `OrgAuditLog` row (`recordOrgAuditEvent`) with actor, subject, and metadata — durable, append-only, exactly the kind of record a compliance product needs and that Fullbloom's `ApprovalQueuePage` lacks entirely.
- It already handles a subtle correctness bug class: a row can be `PENDING_APPROVAL` and independently `revokedAt`-set (withdrawn) at the same time, and `approve_finding_assignment` explicitly checks for that (`action.service.ts:634-639`) — caught by independent review, per the code comment.

This is a closer, better precedent than either Fullbloom or the CDC spec, because it is Qiyrix's own code, already reviewed, already tested, and already uses the real `OrgRole` enum. The recommendation below is essentially "do to `Risk.status` what slice 4 already did to `FindingAssignment.status`," not a new pattern.

## Role Mapping

Real roles, from `organization.schema.prisma:7-12`: `ADMIN`, `LEAD_AUDITOR`, `LIGHT_USER` (external, code-verification, no full account), `VIEWER`. There is no Manager/CRO tier and no plan to invent one — see Open Questions for why a 2-stage chain, not 3, is proposed.

| Real Qiyrix role | Workflow responsibility |
|---|---|
| `LEAD_AUDITOR` (and `ADMIN`, since Admin already has superset access) | **Submits.** Creates/edits a risk; on submission for approval, risk moves to `PENDING_APPROVAL`. This is the role that already owns inspection/finding work in the existing model — the natural "maker." |
| `ADMIN` | **Approves / rejects / escalation-resolves.** Mirrors `approve_finding_assignment`'s `assertIsOrgAdmin` gate exactly. Only Admin can move a risk out of `PENDING_APPROVAL` into `ACTIVE` or `REJECTED`. |
| `LIGHT_USER` | No approval authority. Can view/comment on risks they're scoped to (via the existing `FindingAssignment`-style scoping, if risk access is ever sub-assigned) but cannot submit-for-approval or approve. |
| `VIEWER` | Read-only, no state-changing action at all — consistent with how Viewer works everywhere else in the org model. |

This collapses Fullbloom's 3-role chain (Analyst/Manager/CRO) into a 2-stage maker-checker (Lead Auditor submits → Admin approves), because Qiyrix genuinely only has two roles with any edit authority at all. Forcing a 3-stage chain onto a 2-tier real role model would require either (a) inventing a role that doesn't exist and wasn't CEO-approved in #55, or (b) making Admin approve twice under two different hats, which is theater, not governance. Escalation (see below) is not a third *approval* stage — it's a timeout-driven re-flag of an already-pending item to Admin, using the same `management_response`-style pattern from CDC §7.5 rather than a new organizational tier.

## Alternatives Considered

**A. Status enum + backend-enforced transition table on `Risk` itself** (no new model)
Add `RiskStatus` enum, keep transitions in a small `ALLOWED_TRANSITIONS` map in `risk.service.ts`, gate `PATCH /risk/:id` status changes by role, write to a lightweight audit log.
- Pros: smallest change, fastest to ship, matches "simple enum + transition table is sufficient until you have multiple structurally different flows" from the workflow-engine research above. Fits the org's actual size (per Open Questions, this is not a large team).
- Cons: doesn't naturally carry per-transition metadata (who requested escalation and why, deadline for response) without bolting extra columns onto `Risk` itself, which pollutes the core entity with workflow-only fields.

**B. Generic, reusable `ApprovalRequest` model referencing any approvable entity type (polymorphic)**
One `ApprovalRequest { entityType, entityId, status, requestedById, decidedById, ... }` table usable by Risk today and any other entity (Actions, Findings, Templates) later.
- Pros: reusable, avoids "will need this again" duplication if a second approval flow shows up later (audit plan sign-off is a plausible future candidate, per CDC §7.5's `audit_plan_approval`).
- Cons: premature generalization — Qiyrix has exactly one approval need right now (this ticket) and one already-shipped precedent (`FindingAssignment`) that is *not* built this way; introducing a second, differently-shaped approval mechanism increases surface area for no immediate benefit. The external research is explicit that a generic engine "pays for itself" only once multiple structurally different flows exist — that isn't the case here.

**C. Dedicated `RiskApproval` model, structurally mirroring `FindingAssignment`** (not polymorphic, not folded into `Risk`)
A `RiskApproval` row per risk's current/latest approval cycle: `riskId, status (PENDING_APPROVAL/ACTIVE/REJECTED/ESCALATED), submittedById, decidedById, escalatedAt, dueAt, resolvedAt`, with `Risk.status` staying a derived/denormalized display field.
- Pros: keeps `Risk` itself free of workflow plumbing (consistent with how `FindingAssignment` is a separate table from `Action`, not columns on `Action`); directly reuses the reviewed, tested pattern from slice 4 including its `recordOrgAuditEvent` audit trail; supports the CDC §7.5-style deadline/escalation fields naturally as columns instead of overloading `Risk.status` string values; leaves room to extend later (e.g., add `LEAD_AUDITOR`-side re-submission after rejection) without another migration on `Risk`.
- Cons: one more table and one more join for every risk list view that wants to show approval status (mitigated: `Risk.status` denormalized field stays in sync via the approval service, same as it presumably would in option A).

**Also considered: is a formal approval workflow the right scope at all, vs. a lighter-weight "who can change status" permission gate?**
Given the org's actual size (small team, `ADMIN`/`LEAD_AUDITOR` split, external `LIGHT_USER`s with no standing account) a full maker-checker *queue* with tabs/escalation timers may be more workflow than the org needs today. A materially lighter option: just gate `PATCH /risk/:id`'s `status` field so only `ADMIN` can set it to a small closed enum, with `LEAD_AUDITOR` able to *request* a status change (audit-logged) but not directly set it. That closes the actual security gap the ticket describes (anyone can silently self-approve) without building a queue UI, tabs, or escalation timers at all. This is flagged as an open question for Omar, not resolved here, because it's a genuine product-shape decision, not an engineering one.

## Recommended Approach

**Option C** (dedicated `RiskApproval` model, structurally mirroring `FindingAssignment`), gated to the 2-role maker-checker in the Role Mapping above, **if** a formal workflow is wanted at all (see the scope question above — this is the recommendation conditional on "yes, build it"). Rationale:

1. It is the only option that reuses a pattern Qiyrix has already designed, shipped, and had independently reviewed (`FindingAssignment` + `OrgAuditLog`), rather than inventing a new shape or copying Fullbloom's weaker one.
2. It matches the external research's guidance: a plain enum+transition-table is enough for *one* flow; Option C is effectively that, just as a separate table instead of columns on `Risk`, for the same reason `FindingAssignment` isn't columns on `Action`.
3. It naturally supports the CDC §7.5 escalation-with-deadline shape (`dueAt`, `escalatedAt`) that the Fullbloom precedent conspicuously lacks, without requiring Temporal or any workflow engine — a plain scheduled job (or even lazy check-on-read, given team size) can flag overdue `PENDING_APPROVAL` rows.
4. It avoids Option B's premature generalization and Option A's workflow-columns-on-core-entity smell.

## Data Model (Prisma sketch)

```prisma
enum RiskStatus {
  DRAFT
  PENDING_APPROVAL
  ACTIVE
  REJECTED
}

enum RiskApprovalDecision {
  APPROVED
  REJECTED
  ESCALATED
}

model Risk {
  // ...existing fields unchanged...
  status  RiskStatus @default(DRAFT)   // was: String — see Open Questions on migrating existing freeform values
  version Int        @default(1)       // optimistic lock, mirrors CDC §8.2's PUT .../:id version convention

  approvals RiskApproval[]
}

// Structurally mirrors FindingAssignment (organization.schema.prisma:114-143).
// One row per approval cycle; a rejected/expired cycle doesn't block a fresh
// resubmission, same "revoked doesn't block re-assign" reasoning as
// InspectionAssignment/FindingAssignment.
model RiskApproval {
  id     String @id @default(uuid())
  riskId String
  risk   Risk   @relation(fields: [riskId], references: [id], onDelete: Cascade)

  submittedById String   // Account id of the LEAD_AUDITOR (or ADMIN) who requested approval
  status        RiskApprovalDecision?  // null while pending
  decidedById   String?  // ADMIN who approved/rejected
  decidedAt     DateTime?
  decisionNote  String?  // required on REJECTED, matches "review returns with questions" from Archer precedent

  // Escalation-with-deadline, structurally borrowed from CDC §7.5's
  // management_response workflow (10-day response window pattern) rather
  // than the Clerk-signed §7.2 flow.
  dueAt        DateTime?   // set on submission if org has an SLA configured
  escalatedAt  DateTime?
  escalatedById String?    // usually a system/job actor, or LEAD_AUDITOR who manually escalates

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([riskId])
  @@index([status])
}
```

`Organization.requireApprovalForSubAssignment` already exists as a per-org toggle for the analogous `FindingAssignment` flow; add a parallel `requireApprovalForRiskStatusChange Boolean @default(false)` on `Organization` so orgs that don't want the formal workflow (see scope question above) can opt out without a second code path — `Risk.status` transitions straight to `ACTIVE` on submit when the toggle is off, exactly like `FindingAssignment` does today.

## API Endpoints

All under `/risk`, `auth('ORGANIZATION')` plus an `OrgRole` check via `resolveCallerOrgContext`, same pattern as `action.service.ts`.

| Method | Path | Purpose | Auth scope |
|---|---|---|---|
| `PATCH` | `/risk/:id` | Edit risk fields (existing). **Change**: no longer accepts arbitrary `status` writes — `status` is now derived, not directly settable here. Requires `version` field (optimistic lock) once approval workflow exists, matching CDC §8.2's convention. | `LEAD_AUDITOR` or `ADMIN` (existing scope, tightened) |
| `POST` | `/risk/:id/submit-for-approval` | Moves `DRAFT` → `PENDING_APPROVAL`, creates a `RiskApproval` row (or straight to `ACTIVE` if org toggle is off). | `LEAD_AUDITOR`, `ADMIN` |
| `POST` | `/risk/:id/approve` | Approves the current pending `RiskApproval`; risk status → `ACTIVE`. Mirrors `approve_finding_assignment`'s revoked/already-decided guard checks. | `ADMIN` only |
| `POST` | `/risk/:id/reject` | Rejects; risk status → `REJECTED`. Body requires `decisionNote`. | `ADMIN` only |
| `POST` | `/risk/:id/escalate` | Manual escalation of a still-pending approval past its `dueAt` (or before, if `LEAD_AUDITOR` wants to flag urgency). Sets `escalatedAt`; does not change `Risk.status` itself, just flags the pending row for priority review. | `LEAD_AUDITOR`, `ADMIN` |
| `GET` | `/risk/approvals?status=pending_approval\|approved\|rejected\|all` | Backs the approval-queue UI tabs. | `ADMIN` (queue is Admin's worklist); `LEAD_AUDITOR` sees only their own submissions via a `mine=true` filter |

## UI/Workflow Implications

- New `RiskApprovalQueuePage` (Admin-only route), structurally similar to Fullbloom's tabs/stat-tiles layout (that part of Fullbloom is fine to reuse visually) but wired to the real endpoints above instead of a generic `updateRisk` call, and with the Approve/Reject/Escalate buttons rendered only for `ADMIN` — checked against the caller's real `OrgRole` from the auth context, not just "risk is pending so show buttons to whoever's logged in" as Fullbloom does.
- `RiskRegisterPage.tsx`'s status `<select>` (lines 503-514) is replaced: `LEAD_AUDITOR` gets a "Submit for Approval" action instead of a free-text status dropdown; a status **badge** (Draft / Pending Approval / Active / Rejected) replaces the editable field for everyone else. `ADMIN` retains a direct override path (still audit-logged) for the "our org doesn't want the queue, an admin edits statuses directly" case if the toggle is off.
- Escalated items get a visual flag (color/icon) in both the register and the queue — same `⚡` idea Fullbloom uses for tipping points, repurposed for `escalatedAt IS NOT NULL`.
- `RiskMatrixPage.tsx` / `RiskGraphPage.tsx`: no change needed beyond consuming the new `RiskStatus` enum values instead of freeform strings, since neither page currently branches on status value for anything other than display (confirmed in `92-mock-data-wiring.md`'s prior audit of these pages).

## Approval-confirmation mechanism (Clerk alternative)

CDC §7.2 uses Clerk e-signature on approval. That's off the table — this codebase has its own auth and Clerk was already rejected for this purpose. Two real alternatives:

1. **Recorded confirm-click + audit log entry** (recommended): the `POST /risk/:id/approve` call itself, executed by an authenticated `ADMIN` session, with `decidedById`, `decidedAt`, and an `OrgAuditLog` row (`RISK_APPROVED` / `RISK_REJECTED`, new `OrgAuditAction` enum values alongside the existing `FINDING_ASSIGNMENT_APPROVED`/`REJECTED`) *is* the confirmation record. This is exactly what `approve_finding_assignment` already does — the JWT-authenticated request plus the audit row is the attestation; no separate signature artifact. For a platform of this size and regulatory posture (not evidently pursuing SOX/21 CFR Part 11-grade signature requirements), this is proportionate and it's the mechanism already trusted for finding sub-assignment approval.
2. **Typed confirmation + reason-code, still no cryptographic signature**: require the approver to re-type the risk name or type a short justification before the button submits (a "type to confirm" pattern), still just a UI friction layer over the same click-plus-audit-log mechanism. Adds no real cryptographic assurance over option 1, just harder-to-misclick UX. Worth considering only if Omar wants to slow down accidental one-click approvals of high-severity risks specifically (e.g., gate this to `residual_score` above some threshold), not as a blanket requirement.

Recommendation: option 1, with option 2's "type to confirm" friction reserved for high-severity risks only, as a follow-up refinement rather than day-one scope.

## Open Questions for Omar

1. **Is a formal approval workflow the right scope at all right now?** The Alternatives section above flags a materially lighter option (Admin-only status field, Lead Auditor requests-and-audit-logs but doesn't get a queue UI) that closes the actual security hole (anyone can self-approve silently) without building a queue page, tabs, or escalation timers. Given team size, is the queue UI/escalation-timer scope worth it today, or is it over-building for the org's current headcount? This changes T-shirt size materially (see below).
2. **2-stage (Lead Auditor → Admin) vs. something else?** The role mapping above collapses Fullbloom's 3 stages into 2 because that's what the real role model supports. If you want a genuine 3rd checkpoint (e.g. a second Admin must co-sign above some severity threshold — a real "two-person rule" pattern used in higher-assurance GRC deployments), that's a materially different (and larger) design than what's sketched here; flag now if wanted, since it changes the data model (need to distinguish "first approval" from "second approval" on the same `RiskApproval` row or add a second row type).
3. **Deadline/escalation timing**: is a 10-day SLA (matching CDC §7.5's finding-response pattern) the right default for `dueAt`, or does risk approval warrant a different window? Should `dueAt` even be enforced automatically (a scheduled job flips to "overdue" and auto-notifies), or is manual escalation (an `LEAD_AUDITOR` clicking "escalate") sufficient given no Temporal/job-scheduler infra currently runs in `aexa-server`? A lazy "check on read" (compute overdue status when the queue is fetched, no background job) is the low-infra option consistent with the org's current stack.
4. **Migration of existing freeform `status` values**: current data has `open`/`in_progress`/`completed`/`closed` strings in production (per `RiskRegisterPage.tsx`'s existing `<select>` options). None of these map cleanly onto `DRAFT`/`PENDING_APPROVAL`/`ACTIVE`/`REJECTED`. Need an explicit backfill decision (e.g. all existing non-closed risks become `ACTIVE` with no approval history, `closed` becomes... a 5th status? out of scope of the approval chain entirely?) before this ships, not left implicit.
5. **Does `LIGHT_USER` ever need visibility into approval status** for risks they're scoped to via a future `RiskAssignment` (parallel to `FindingAssignment`)? Not building that sub-assignment mechanism in this doc's scope, but the `RiskApproval` model should not preclude it later.

## Effort Estimate

- **If scope is the lightweight status-gate only** (Open Question 1, option "no"): **S** — role check on the existing `PATCH /risk/:id`, a few new `OrgAuditAction` enum values, no new model, no new UI page.
- **If scope is the full `RiskApproval` model + queue UI + manual escalation** (this doc's main recommendation, no auto-deadline job): **M** — one migration, ~4 new endpoints, one new frontend page, register-page status-field changes, unit tests for the transition table (per the repo's existing "tests land in the same task" convention).
- **If scope additionally includes automatic deadline enforcement / reminders** (Open Question 3, "yes, automatic"): **M/L** — needs a scheduled job or cron-equivalent that doesn't exist in `aexa-server` today; this is the one piece that would introduce new infrastructure, however light.
