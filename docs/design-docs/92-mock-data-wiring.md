# Design Doc: aexa-frontend#92 — Wire remaining mock data to real backend

Status: draft for review
Scope: design-only, no code changes made

## Problem Statement

Ticket #92 lists four pages as still rendering mock data: RiskMatrixPage, RiskGraphPage, AuditPage, and Overview. On inspection, two of those four are already fixed. The remaining work is narrower than the ticket implies, and one piece (RiskGraphPage) has a real backend gap, not just a wiring gap.

## Current State (file:line findings)

### RiskMatrixPage.tsx — already fixed, not mock

`aexa-frontend/src/dashboard/organization/risk/RiskMatrixPage.tsx:4,58-74` calls `useGetAllRisksQuery` and `useGetAllSitesQuery`, same as `RiskRegisterPage.tsx`, and reshapes the result into matrix cells client-side via `mapRiskToCell()` (lines 44-54). No `mockData` import present.

This was fixed in PR #105 ("feat: wire RiskMatrixPage, Overview, and CriticalAlertBanner to real data"), confirmed via `git log -- RiskMatrixPage.tsx`. The ticket body is stale on this page.

### Overview.tsx — already fixed except one deliberately-flagged gap

`aexa-frontend/src/dashboard/organization/overview/Overview.tsx:8-10,48-64` uses `useGetAllRisksQuery`, `useGetAllKriQuery`, `useGetAllAlertsQuery`. Also fixed in PR #105.

Two remaining mock references, both intentionally left with inline comments explaining why:
- Line 7, 308-309: `mockRisks.filter(r => r.is_tipping_point)` for the "Tipping Points" panel. Comment at lines 302-307 states `is_tipping_point` has no field on the real `Risk` type or backend — this is a missing concept, not a wiring gap. Correctly left as a flagged TODO rather than guessed at.
- Lines 33-44: `ebitdaData` is static placeholder for an EBITDA percentile chart. Comment states no backend endpoint returns this anywhere in the project, and it's out of scope for #92 (financials, not risk/audit).

Not a regression — this is the "closed issue" the ticket refers to, and the remaining gaps are already labeled, not silently reintroduced.

### RiskGraphPage.tsx — still mock, and the backing data model doesn't exist yet

`aexa-frontend/src/dashboard/organization/risk/RiskGraphPage.tsx:2,22-23`:
```
import { DUMMY_LINKS, mockRisks } from "@/data/mockData"
const [risks] = useState<Risk[]>(mockRisks)
const [links] = useState<RiskLink[]>(DUMMY_LINKS)
```
`mockRisks` is trivially replaceable with `useGetAllRisksQuery` (same data RiskRegisterPage/RiskMatrixPage already fetch). `DUMMY_LINKS` is not — see Backend Data Availability below.

### AuditPage.tsx — still mock, and there is no audit backend at all

`aexa-frontend/src/dashboard/organization/audit/AuditPage.tsx:3,39-40`:
```
import { mockAuditEngagements } from "@/data/mockData"
const [engagements, setEngagements] = useState<AuditEngagement[]>(mockAuditEngagements)
```
All CRUD is local `useState` mutation: `handleSave` (line 88-102) has the real payload shape commented out ("when i make api then i will use this payload"), `handleDelete` (104-108) mutates state directly, `handleReportUpload` (110-115) and `handleDownloadReport` (117-120) are `alert()` stubs. This page has no backend integration of any kind, not even a read-only query.

## Backend Data Availability

| Data needed | Exists? | Where |
|---|---|---|
| Risk list (name, scores, probability, category, site) | Yes | `GET /risk` via `aexa-server/src/app/modules/risk/risk.route.ts:9`, consumed by `risk.api.ts`'s `useGetAllRisksQuery` |
| Risk CRUD | Yes | `risk.route.ts:9-23` (GET/POST/GET:id/PATCH/DELETE), all `auth('ORGANIZATION')`-scoped |
| Risk-to-risk links (RiskLink: source_ref, target_ref, link_type, strength) | **No** | `aexa-server/prisma/schema/risk.prisma` has no RiskLink model and no relation field on `Risk` for it. Grepped all of `prisma/schema/*.prisma` — nothing named `risk_link`/`RiskLink` anywhere. |
| PageRank score | Partially | `Risk.pagerank_score` field exists on the model (`risk.prisma:10`) but nothing populates or recalculates it — no `/risks/:id/pagerank` or `/risks/graph/pagerank` endpoint exists server-side. The CDC spec (lines ~1249-1257, ~1420) describes this as Neo4j GDS PageRank; the actual DB is Postgres/Prisma with no graph engine. |
| Audit engagements (CRUD) | **No** | No `audit` directory under `aexa-server/src/app/modules/` at all — confirmed via `find`. Nothing in `routes.ts` for `/audit`. |
| Audit plans, findings, feedback loop to risks | **No** | Same — none of §7.5/§7.6 of the CDC spec (audit workflow, IIA findings structure, audit→risk feedback loop) exists in the codebase. |

**Reference comparison — Fullbloom** (`YouYouLux/full-bloom-app`, `main`):
- `src/features/risks/pages/RiskMatrixPage.tsx` and `RiskGraphPage.tsx` are close structural twins of the aexa versions (same `mapRiskToCell`, same domino-chain DFS, same category-cluster layout math) — confirming this UI was ported/adapted from Fullbloom.
- Fullbloom's `RiskGraphPage.tsx` calls `getRiskLinks(currentOrg.id)`, which queries a real Supabase table: `src/shared/services/database.ts:81-88` does `supabase.from('risk_links').select('*').eq('organization_id', ...)`. Fullbloom has a working `risk_links` table; aexa-server does not. This is the concrete gap DUMMY_LINKS is standing in for.
- Fullbloom has no equivalent `AuditPage` — audit tracking isn't part of that reference app, so there's no shortcut to borrow there either.

The CDC master spec (`/tmp/cdc-spec.txt` §7.2, §7.5-7.6, §8.2) describes a much larger target: Neo4j-backed dependency graphs, Temporal workflows for the full IIA audit cycle, an audit→risk feedback loop publishing Kafka events. None of that infrastructure exists in aexa-server today (Express/Prisma/Postgres only, no Neo4j, no Temporal, no Kafka). Building AuditPage or RiskLinks to that full spec is a separate, much larger initiative — not a wiring fix.

## Recommended Approach per page

**RiskMatrixPage** — no action needed. Already correctly wired (PR #105). Verify it's not accidentally re-flagged in whatever triggered #92 being reopened.

**Overview** — no action needed. Already correctly wired (PR #105) with the two remaining mock references clearly commented as intentional, out-of-scope gaps. Leave as-is; the comments already do the job of communicating this to future readers.

**RiskGraphPage** — split fix:
- Swap `mockRisks` → `useGetAllRisksQuery` (same call RiskMatrixPage/RiskRegisterPage already make). Zero new backend work. Straightforward client-side reuse.
- Keep `DUMMY_LINKS` as-is, but add the same kind of inline comment Overview.tsx already uses elsewhere in this codebase (`RiskGraphPage.tsx` currently has none) explaining that `RiskLink` has no backend model yet, so the domino-chain/cascade visualization is illustrative only until risk_links ships. Do not attempt to fake real links from existing Risk fields (e.g. inferring links from shared category) — that would present fabricated relationships as data, which is worse than an honestly-labeled empty/mock state.
- Rationale: this delivers real risk nodes (the "risks" the page's title and axis labels claim to show) while being honest that the edges are placeholder, matching the pattern Overview.tsx already established for `is_tipping_point`.

**AuditPage** — do not attempt to wire to a real backend in this ticket. There is no audit module, route, service, or Prisma model to wire to — this isn't a mock-data swap, it's a full new module (data model + CRUD routes + RTK Query slice + file upload for reports). That is a separate, properly-scoped feature ticket (see CDC §7.5 for the intended full scope, though a minimal MVP — `AuditEngagement` CRUD only, no plans/findings/feedback loop — would be a reasonable first slice). Recommend closing out the AuditPage portion of #92 as "descoped — filed as new ticket" rather than fixing it here.

## Data Model Changes Needed

Only sketching where a real gap was confirmed — RiskLink (needed for RiskGraphPage to eventually show real edges) and AuditEngagement (needed for AuditPage, if/when that ticket is taken up). Not proposing to build either in this ticket; included for scoping the follow-up work.

```prisma
// risk.prisma — addition, NOT part of this ticket's fix
model RiskLink {
    id              String   @id @default(uuid())
    org_account_id  String
    account         Account  @relation(fields: [org_account_id], references: [id])
    source_risk_id  String
    source_risk     Risk     @relation("RiskLinkSource", fields: [source_risk_id], references: [id], onDelete: Cascade)
    target_risk_id  String
    target_risk     Risk     @relation("RiskLinkTarget", fields: [target_risk_id], references: [id], onDelete: Cascade)
    link_type       String   // CAUSES | AMPLIFIES | CORRELATES
    strength        Float
    createdAt       DateTime @default(now())

    @@index([org_account_id])
}
```
```prisma
// new audit.prisma — addition, NOT part of this ticket's fix, minimal MVP slice only
model AuditEngagement {
    id                 String    @id @default(uuid())
    org_account_id     String
    account            Account   @relation(fields: [org_account_id], references: [id])
    ref                String
    title              String
    scope              String?
    status             String    // planned | in_progress | completed
    lead_auditor       String?
    priority_score     Int?
    findings_count     Int       @default(0)
    started_at         DateTime?
    closed_at          DateTime?
    linked_risk_refs   String[]
    report_url         String?
    ai_generated       Boolean   @default(false)
    is_edited          Boolean   @default(false)
    createdAt          DateTime  @default(now())
    updatedAt          DateTime  @updatedAt

    @@index([org_account_id])
}
```
Note: uses `org_account_id` (snake_case) per the aexa-server convention for risk/kri/alert/site models (see aexa-server/CLAUDE.md org-scoping table).

## Effort Estimate

| Page | Effort | Notes |
|---|---|---|
| RiskMatrixPage | None | Already done |
| Overview | None | Already done |
| RiskGraphPage (risks only) | S | Swap import + hook call, same pattern as RiskMatrixPage; add scoping comment for DUMMY_LINKS |
| RiskGraphPage (real links) | Out of scope for #92 | Requires RiskLink model + migration + CRUD route + RTK slice + drag-to-link UI; separate ticket, likely M-L |
| AuditPage | Out of scope for #92 | Requires new module end-to-end (model, route, service, validation, RTK slice, file upload wiring); separate ticket, likely L |

## Open Questions for Omar

1. Should #92 be narrowed to just the RiskGraphPage risks-fetch fix, with RiskLink and AuditPage split into their own tickets? That matches what's actually left to do and avoids the ticket silently expanding into two unscoped features.
2. For RiskGraphPage: is a placeholder/empty-state for links acceptable near-term (ship real nodes, honest "no link data yet" edges), or should the graph view itself be hidden/flagged until RiskLink exists, to avoid presenting a domino/cascade feature that can't currently produce real results?
3. For AuditPage: is the CDC's full IIA audit-cycle scope (§7.5-7.6 — plans, IIA finding structure, audit→risk feedback loop, Temporal workflows) the actual target, or is a minimal `AuditEngagement` CRUD (matching what AuditPage.tsx's UI already assumes) the right first slice? The current frontend only needs the latter; the former is a multi-sprint effort requiring infrastructure (Temporal, Kafka) not present in aexa-server today.
4. `Risk.pagerank_score` exists on the schema but nothing computes it — is this intentionally deferred (matches the "no Neo4j" reality), or should the field be removed until there's a real calculation path, to stop UI from displaying a number that's really just whatever was typed into the create-risk form?
