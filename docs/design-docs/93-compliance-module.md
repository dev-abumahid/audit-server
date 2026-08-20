# Design: Compliance Obligations Module (aexa-frontend#93)

Status: Needs product decision (Omar)
Author: Claude (design-only, no code changes)
Date: 2026-07-21

## Problem Statement

`aexa-frontend/src/dashboard/organization/compliance/CompliancePage.tsx` renders a complete CRUD UI — obligation table, jurisdiction/status filters, penalty-exposure rollup, create/edit modal — but every interaction is fake:

- State is seeded from `mockCompliance` in `/Users/omartakadoum/Qiyrix/aexa-frontend/src/data/mockData.ts:286` (four hardcoded rows), not a fetch.
- `handleSave()` (`CompliancePage.tsx:97-104`) only flips `isSaving` and closes the modal — no network call, no persistence. A page refresh reverts every edit.
- `handleDelete()` (`CompliancePage.tsx:106-110`) filters local React state and pops a browser `alert()` — nothing is deleted anywhere real.
- `grep -r "compliance" aexa-server/src/app/modules/` returns nothing: there is no Prisma model, service, controller, route, or validation schema for compliance on the server. The module doesn't exist at any layer below the component.

This is not a bug to patch — it's an entire backend module that was never built, sized comparably to the existing KRI (`aexa-server/prisma/schema/kri.prisma`, 21 lines) and Alert (`alert.prisma`, 20 lines) modules, but with real CRUD surface closer to the Action module (`aexa-server/src/app/modules/action/`, ~1,100 lines across 4 files). The ticket asks for a scope and priority call, not code.

## Research Findings

### Fullbloom precedent (github.com/YouYouLux/full-bloom-app, main)

Fullbloom's `CompliancePage.tsx` (`src/features/compliance/pages/CompliancePage.tsx:1-264`) is UI-identical to Qiyrix's shell (same fields, same layout, same status/penalty cards) but wired to a real Supabase table:

- `getComplianceObligations(orgId)` (`src/shared/services/database.ts:204-212`) — `select('*').eq('organization_id', orgId).order('deadline')`.
- `handleSave()` (`CompliancePage.tsx:74-92`) does a real `supabase.from('compliance_obligations').insert(...)` or `.update({...form, is_edited: true})`.
- `handleDelete()` (`CompliancePage.tsx:94-97`) does a real `.delete().eq('id', id)`.
- Table schema (`supabase/migrations/20260322002407_d5af8158-9734-407e-8aa9-5d3a4bc5132f.sql:236-258`):

```sql
CREATE TABLE public.compliance_obligations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  regulation TEXT NOT NULL,
  jurisdiction TEXT,
  description TEXT,
  deadline DATE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('compliant','partial','non_compliant','pending')),
  penalty_estimate NUMERIC DEFAULT 0,
  owner TEXT,
  ai_generated BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Notably: no `is_edited` column in the SQL (it's set at update time but there's no matching DDL — a Fullbloom bug, not something to copy), row-level security is per-`user_id` not per-org-role, and there is no attachment/evidence field at all — Fullbloom's obligation registry is flat metadata, no supporting documents. This is a **simple manual registry**, not a regulatory-feed-driven one — useful as a "floor," not a ceiling.

### CDC spec precedent (`/tmp/cdc-spec.txt`, section 7.7 "Module Conformité Réglementaire", lines 1356-1369)

The spec describes five features under this module, in increasing order of ambition:

1. **Registre obligations** (line 1359-1360): full CRUD, plus automatic import from EUR-Lex + LexisNexis. Each obligation carries reference text, org scope, deadline, status, estimated penalty, owner, required action.
2. **Veille réglementaire automatique** (1361-1362): a daily worker polling EUR-Lex (sector/country keywords), OFAC (sanctions), CISA (cyber advisories), running NLP entity extraction, matching against the org's profile, and alerting the Compliance Officer when a new obligation clears a 0.5 relevance threshold.
3. **Alertes deadlines** (1363-1364): daily cron sending notifications at J-90/J-60/J-30/J-14/J-7/J-0, escalating to CODIR (executive committee) if J-7 and still non-compliant, via email + Slack + dashboard.
4. **Scorecard conformité** (1365-1366): a sites × domains matrix, score = compliant obligations / total applicable obligations for that site×domain cell, computed daily, red <70%, orange 70-85%, green >85%.
5. **Déclaration conformité CA** (1367-1368): auto-generated signable Word document — scorecard synthesis + critical obligations + action plan + signatories (DG/CEO, Compliance, CRO) — with an e-signature workflow.

API surface (lines 1546-1555):
```
GET  /api/v1/compliance/obligations   compliance:read   status, jurisdiction, deadline_before
POST /api/v1/compliance/scan          compliance:admin  Body: jurisdictions[], keywords[] optionnels
```
Only two endpoints are specified — obligations listing and a scan trigger. No CRUD write endpoint is documented, no scorecard endpoint, no declaration endpoint; those are described narratively but never reach the API table. That gap itself is a signal the spec's compliance section was left less fully speced than risk/audit/KRI.

RBAC (lines 1588-1618): `compliance_officer` gets `compliance:write, risks:read, alerts:read`; `risk_manager` gets `compliance:read` (bundled with `risks:write, kri:write, alerts:write`); `executive` gets `risks:read, kri:read, alerts:read, reports:generate, finance:read` — no explicit `compliance:*` scope, so executives would only see compliance data via the future `reports:generate` (board declaration) path, not the obligations registry directly, per the spec text as written.

**Important gap**: this RBAC table (compliance_officer / risk_manager / executive / auditor / etc., scoped via Clerk JWT claims) does not exist in the current codebase. `aexa-server`'s actual `Account.role` enum is `ADMIN | USER | ORGANIZATION` (`aexa-server/prisma/schema/account.schema.prisma:22`), and every existing route (including `action.route.ts`) gates on the single `auth('ORGANIZATION')` middleware — there is no scope/permission layer to hang `compliance:write` off of today. The CEO-approved role hierarchy from issue #55 (Admin / Lead Auditor / Light user) is the closer real precedent, and it's still mid-rollout. Building fine-grained `compliance_officer`-vs-`risk_manager` scoping now would be inventing a permission system the rest of the app doesn't have, ahead of #55 settling org-wide roles.

Also per prior decision: Clerk.com is not used in this codebase for auth or e-signature (rejected earlier). The spec's "workflow signature électronique" for board declarations assumes Clerk Enterprise SSO/e-sign, which doesn't apply here.

### External industry research

Three real patterns, compared:

**1. Manual/static obligations register** (spreadsheet-replacement tier — e.g. plain GRC starter tools, Fullbloom's own implementation). A flat table: obligation text, jurisdiction, framework, owner, deadline, status. No automation. Matches ISO 37301's baseline requirement that a compliance management system maintain "a systematic register of all applicable obligations... kept current and accessible," with "an owner, a control description, and a testing cadence" per obligation ([ISO 37301:2021](https://www.iso.org/standard/75080.html); [Nimonik summary](https://nimonik.com/blog/iso-37301-compliance-management-systems-key-elements/)). This is the floor — necessary but not differentiated.

**2. Registry + framework/control mapping + evidence** (mid-market GRC — LogicGate Risk Cloud, Resolver, OneTrust). LogicGate's graph-database model links regulations → obligations → assessments/exams → findings → remediation plans, so an obligation isn't just a row, it's a node with relationships to controls and evidence ([LogicGate solutions overview](https://www.logicgate.com/solutions/)). OneTrust adds jurisdiction breadth (300+ jurisdictions) and a "collect once, comply across 50+ frameworks" shared-evidence model ([OneTrust GRC glossary](https://www.onetrust.com/glossary/governance-risk-and-compliance-grc/)). This is the shape a scorecard-driven MVP should aim at: obligations carry attachments/evidence and map to a status used for aggregate scoring, without necessarily building the full control-testing graph.

**3. Continuous automated monitoring** (Vanta, Drata). These platforms replace manual evidence gathering with integrations that pull evidence automatically from cloud/HR/ticketing systems and run control tests on an hourly (Vanta) or daily (Drata) cadence, flagging drift in near-real-time rather than at audit time ([Drata vs Vanta comparison](https://drata.com/learn/compare/delve-vs-vanta-vs-drata)). This is the CDC spec's "veille réglementaire automatique" idea taken even further (integration-driven evidence vs. regulatory-text scraping) — powerful, but it presumes dozens of pre-built connectors and a customer base large enough to justify maintaining them. Not attainable for a small team's MVP.

COSO's compliance-risk view reinforces pattern 2 as the right MVP target: build "an obligations library," assign owners, score/track compliance per obligation, and keep an audit trail of status changes and evidence as proof for auditors ([COSO framework guide, ZenGRC](https://www.zengrc.com/blog/guide-to-coso-framework-and-compliance/); [MetricStream COSO guide](https://www.metricstream.com/learn/coso-framework.html)) — control testing and audit trail, not real-time external data ingestion.

## Alternatives Considered

**A. Minimal manual registry (Fullbloom parity).** CRUD only — obligation, jurisdiction, description, deadline, status, penalty estimate, owner. No scorecard, no evidence attachments, no deadline alerts. Smallest possible slice; directly closes the "no backend at all" gap.
- Pros: fastest to ship (roughly KRI/Alert-sized), zero new infrastructure, matches what the UI shell already renders field-for-field.
- Cons: doesn't use the `attachments`/evidence pattern the org already has (Action module), doesn't give CEO/CRO/CAE personas the aggregate view the "penalty exposure" card on the page implies they want; the scorecard rollup currently shown (compliant/non-compliant counts, total penalty) is derived client-side over the full unfiltered list, which won't scale once real orgs have hundreds of obligations across multiple sites.

**B. Registry + scorecard + evidence attachments + deadline alerts (recommended — see below).** Adds: Cloudinary/S3 attachment pattern (same as Action's `attachments: String[]`), a computed compliance-scorecard endpoint (per-site or per-org rollup, red/orange/green thresholds per CDC spec), and deadline reminders reusing the existing alert/notification plumbing (Alert model, BullMQ queue) rather than a new cron subsystem.
- Pros: matches the mid-market GRC pattern (LogicGate/OneTrust) that's proportionate for a paid GRC product; scorecard and deadline alerts are the two features CEO/CRO/CAE personas will actually look at (nobody reads a raw obligations table, they read "are we green"); reuses existing infra (Alert model + BullMQ) instead of inventing new plumbing.
- Cons: meaningfully bigger than KRI/Alert — closer to Action-module size; scorecard formula (compliant/total per site×domain) needs a "domain" taxonomy decision that doesn't exist in the schema yet (see Open Questions).

**C. Full spec parity — regulatory-watch automation (EUR-Lex/OFAC/CISA scraping, NLP extraction, Kafka events) + Word-doc board declaration with e-signature.** Builds everything in CDC 7.7 as written.
- Pros: matches the original vision; would be a genuine product differentiator eventually.
- Cons: as flagged going in, this is Phase-2/stretch scope for an MVP-stage small team — daily scraping workers, a keyword-to-entity NLP pipeline, and Kafka event plumbing don't exist anywhere else in this codebase (no queue infra for external scraping today, only BullMQ for internal jobs), and would need external legal-data API contracts (EUR-Lex, LexisNexis are not free/self-serve at meaningful volume) before a line of code gets written. E-signature also can't reuse Clerk (rejected) and would need a real e-sign vendor decision (e.g., a lightweight audit-trail "typed name + timestamp + IP + org-role" confirmation, not a full DocuSign integration) which is its own scoping conversation.

## Recommended Approach

**Ship Alternative B, phased:**

- **Phase 1 (MVP, this ticket's scope):** Manual obligations registry with full CRUD, org-scoped, evidence attachments (reuse Action's Cloudinary/S3 attachment pattern), and a computed scorecard summary (compliant/total, red/orange/green) surfaced on the existing summary cards — replacing the current client-side count with a real aggregate, still computed on read (no daily cron needed yet, just compute at request time or cache lazily).
- **Phase 1.5 (fast follow, same size ballpark):** Deadline alerts. Reuse the existing `Alert` model and BullMQ queue infra (`aexa-server/src/app/queues/`) to schedule J-30/J-7/J-0 style reminders instead of building a new notification channel — this is a queue job, not a new subsystem.
- **Phase 2 (explicitly out of scope, flag and defer):** EUR-Lex/OFAC/CISA regulatory-watch scraping + NLP extraction + Kafka events, and the Word-doc board declaration with e-signature. Both require infrastructure and vendor decisions this codebase doesn't have yet (external legal-data API contracts, a document-generation pipeline, an e-signature approach that isn't Clerk). Worth a separate ticket once Phase 1 is live and there's real usage data on whether anyone would use auto-import.

Rationale: the ticket's own framing ("comparable in size to KRI/Alert modules") undersells what's needed to make the existing UI's summary cards (penalty exposure, compliant/non-compliant counts) mean something at scale, but a straight Fullbloom port (Alternative A) would ship a worse version of a UI Qiyrix already has a screenshot-identical shell for. Alternative B is the smallest scope that makes the shipped UI's own promises (deadline overdue highlighting, penalty rollup) true, without taking on infrastructure this team doesn't have reason to build yet.

## Data Model (Prisma schema sketch)

New file `aexa-server/prisma/schema/compliance.prisma`, following the `action.prisma` / `kri.prisma` conventions (camelCase FK, `orgAccountId`, indexed, `onDelete: Cascade` to Account):

```prisma
enum ComplianceStatus {
  COMPLIANT
  PARTIAL
  NON_COMPLIANT
  PENDING
}

model ComplianceObligation {
  id String @id @default(uuid())

  // FK — org scoping, camelCase per action/recommendation/template convention
  orgAccountId String
  orgAccount   Account @relation(fields: [orgAccountId], references: [id], onDelete: Cascade)

  // Optional site scope — needed if/when the scorecard is site x domain,
  // per CDC 7.7's "matrice sites x domaines". Nullable: an obligation can
  // be org-wide (e.g. SOX) or site-specific (e.g. a local environmental permit).
  siteId String?
  site   Site?   @relation(fields: [siteId], references: [id], onDelete: SetNull)

  regulation       String
  jurisdiction     String?
  domain           String?           // e.g. "Data Protection", "Financial Reporting" — scorecard grouping axis
  description      String?
  deadline         DateTime?
  status           ComplianceStatus  @default(PENDING)
  penaltyEstimate  Decimal           @default(0) @db.Decimal(14, 2)
  owner            String?           // free-text owner name, matches existing UI field (not FK to OrgMember yet — see Open Questions)
  actionRequired   String?           // "action requise" per CDC spec — what needs to happen to close the gap
  attachments      String[]          @default([])  // same pattern as Action.attachments (evidence URLs)

  aiGenerated Boolean @default(false)
  isEdited    Boolean @default(false)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([orgAccountId])
  @@index([siteId])
  @@index([deadline])
}
```

Notes:
- `Decimal(14,2)` for `penaltyEstimate` rather than `Float` (Fullbloom used `NUMERIC`) — money fields should not use binary floats; this matches how a currency amount should be modeled even though nothing else in the current schema enforces it yet.
- `status` as a Prisma enum rather than Fullbloom's `TEXT CHECK` — matches `action.prisma`'s `PRIORITY`/`STATUS` enum convention.
- No `userId`/"created by" field like Fullbloom's — not needed given org-level `auth('ORGANIZATION')` scoping matches every other module here; if per-user attribution matters later it's an additive column.
- Scorecard is **not** a separate table in Phase 1 — compute it as an aggregation query (`GROUP BY siteId, domain` over status) at read time. Add a materialized/cached version only if query load becomes a real problem.

## API Endpoints

Following `action.route.ts`'s pattern (`auth('ORGANIZATION')` gate, no fine-grained scopes today — see RBAC gap above):

| Method | Path | Purpose | Auth (today) | Auth (CDC spec scope, for future reference) |
|---|---|---|---|---|
| GET | `/compliance` | List obligations, filterable by `status`, `jurisdiction`, `deadlineBefore` | `auth('ORGANIZATION')` | `compliance:read` |
| POST | `/compliance` | Create obligation | `auth('ORGANIZATION')` | `compliance:write` |
| GET | `/compliance/:id` | Single obligation detail | `auth('ORGANIZATION')` | `compliance:read` |
| PATCH | `/compliance/:id` | Update obligation (sets `isEdited: true`) | `auth('ORGANIZATION')` | `compliance:write` |
| DELETE | `/compliance/:id` | Delete obligation | `auth('ORGANIZATION')` | `compliance:write` |
| POST | `/compliance/attachment` | Upload evidence file, returns URL (same two-step pattern as `action.route.ts`'s `/attachment`) | `auth('ORGANIZATION')` | `compliance:write` |
| GET | `/compliance/scorecard` | Aggregate compliant/total by site×domain, with red/orange/green banding | `auth('ORGANIZATION')` | `compliance:read` (or `risks:read`/`reports:generate` for executive view) |

Phase 2 (not built now, listed for completeness): `POST /compliance/scan` (regulatory-watch trigger, `compliance:admin`), `POST /compliance/declaration` (board declaration doc generation).

## UI/Workflow Implications

The existing `CompliancePage.tsx` shell maps almost directly onto this API — it already has the right fields, it just needs real wiring:

- Replace `useState<ComplianceObligation[]>(mockCompliance)` (`CompliancePage.tsx:39-40`) with a fetch on mount (RTK Query, matching the rest of `main`'s data-fetching convention per the dev→main merge — see `project_architecture` memory) hitting `GET /compliance`.
- `handleSave()` (`CompliancePage.tsx:97-104`): call `POST /compliance` (create) or `PATCH /compliance/:id` (edit) instead of the no-op; on success, invalidate/refetch instead of relying on local state.
- `handleDelete()` (`CompliancePage.tsx:106-110`): call `DELETE /compliance/:id`, replace the `alert()` with a toast (repo already has toast infra elsewhere per Fullbloom's `useToast` pattern — confirm equivalent exists in current `aexa-frontend`).
- The three summary cards (compliant count, non-compliant count, total penalty) currently compute over `filtered` client-side (`CompliancePage.tsx:112-118`) — fine to keep client-side for Phase 1 since it's the same list already fetched; only move to the `/compliance/scorecard` endpoint once site×domain grouping is actually needed (i.e., once the UI adds a scorecard view, not just the three summary cards it has today).
- New UI needed, not yet in the shell: an attachments/evidence upload control in the create/edit modal (matching how findings attach evidence in the Action/inspection flow), and eventually a dedicated Scorecard view for the site×domain matrix — out of scope for wiring the existing page, but worth flagging as a follow-up ticket once Phase 1 ships.

## Open Questions for Omar

1. **Scope confirmation**: is Phase 1 (registry + attachments + scorecard) the right cut, or do you want Phase 1.5 (deadline alerts) bundled into the same ticket/PR? They're small on top once the Alert/BullMQ reuse is confirmed to work the way I'm assuming.
2. **`domain` taxonomy**: the scorecard needs a "domain" axis (CDC spec's "sites × domaines" matrix) — e.g. Data Protection, Financial Reporting, Health & Safety, Environmental. Is this a fixed enum, a free-text field like `owner`, or should it map onto whatever risk-category taxonomy already exists elsewhere in the app? I didn't find an existing "domain" concept in `risk.prisma` to reuse — worth confirming before locking the schema.
3. **Owner as free text vs. FK**: current UI and Fullbloom both store `owner` as a plain string. Action's `ActionResponsible` model shows the convention for a real FK-to-OrgMember assignee. Do you want compliance ownership to be assignable/queryable (FK) from the start, or is free text fine until the #55 role work settles who counts as a valid assignee?
4. **RBAC**: given `compliance_officer`/`risk_manager`/`executive` scopes from the CDC spec don't exist in the actual permission system yet (only `ADMIN`/`USER`/`ORGANIZATION`), should this module just use `auth('ORGANIZATION')` like every other module today, or is this the point where a real scope layer gets built? I'd default to reusing the existing pattern and revisiting once #55's role hierarchy lands, rather than building a one-off permission system just for compliance.
5. **Regulatory-watch automation (Phase 2)**: confirming this stays out of scope for now — EUR-Lex/LexisNexis auto-import and OFAC/CISA scraping need external data contracts and a scraping/NLP pipeline this codebase doesn't have; treat as a separate future ticket, not part of #93.

## Effort Estimate

- **Phase 1 (registry + attachments + scorecard endpoint):** M — one module, 4 files (route/controller/service/validation) plus the Prisma model, following the Action module's structure almost exactly (it's smaller than Action since there's no sub-assignment/approval workflow). Comparable to Action minus its Slice-4/5 assignment features, or roughly 1.5-2x KRI+Alert combined given the scorecard aggregation query and attachment upload endpoint.
- **Phase 1.5 (deadline alerts via existing Alert/BullMQ infra):** S — a queue job plus wiring into the existing Alert model, no new infrastructure.
- **Phase 2 (regulatory-watch automation, board declaration + e-signature):** L-XL and explicitly deferred — not estimated here pending a separate scoping ticket, since it depends on vendor/API decisions (EUR-Lex/LexisNexis access, e-signature approach) that haven't been made.
