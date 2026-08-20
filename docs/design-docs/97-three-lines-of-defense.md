# Design: "Three Lines of Defense" Governance View (aexa-frontend#97)

Status: Needs product decision (Omar)
Author: Claude (design-only, no code changes)
Date: 2026-07-21

## Problem Statement

Fullbloom's `ThreeLinesOfDefensePage.tsx` classifies risks, mitigations, KRIs, compliance obligations, audit engagements, and audit findings by IIA "line of defense" (1/2/3), and lets users reassign items between lines from a dedicated governance page. `grep -n "line_of_defense" aexa-server/prisma/schema/*.prisma` returns nothing — the concept doesn't exist anywhere in the Qiyrix data model, and there is no equivalent page in `aexa-frontend`.

This is distinct from the org/team model in #55 (deliberately simplified — not a gap). It is a specific compliance-framework artifact: mapping risk/control/audit records to the IIA's line-of-defense structure. Whether this framework concept belongs in the product at all is a product/domain question, which is exactly what the issue asks to have answered — not an engineering question of how to build it.

## Research Findings

### Internal precedent — CDC spec (`/tmp/cdc-spec.txt`)

I read the full glossary/closing section (lines 1970–2091) and grepped the entire document for `gouvernance`, `IIA`, `IPPF`, and `ligne de défense`. The result confirms the ticket's framing: this is the thinnest internal precedent of any GRC ticket in the batch.

Every "IIA" hit in the spec (lines 73, 74, 99, 142, 502, 869, 1320, 1327, 1334, 1340, 1528, 1538, 1813, 1832, 2028, 2051) is about the **audit module** — risk-based audit planning, finding structure (Criteria/Condition/Effect/Cause/Recommendation), assurance opinions, IIA-IPPF-conformant templates. None of them describe a three-lines classification concept. Line 99 claims "Conforme IIA-IPPF 2024" as a headline differentiator but never elaborates what that conformance consists of beyond the audit-finding structure.

The **only** reference to the three-lines concept anywhere in the document is incidental, in the glossary at line 2068:

> RCSA — Risk and Control Self-Assessment. Auto-évaluation des risques et contrôles par le management (1re ligne de défense). Exportable depuis AEXA.

That's a single gloss defining an acronym, in passing mentioning "1st line of defense" as management's role in self-assessment. It is not a feature spec, not a data model, not a UI description, and not evidence that a three-lines governance view was ever planned. I'm treating this as effectively zero internal precedent, not stretching it into a requirement.

### Fullbloom precedent (`github.com/YouYouLux/full-bloom-app`, main)

I fetched `src/features/governance/pages/ThreeLinesOfDefensePage.tsx` in full (182 lines) — it's the only file in `src/features/governance/`, no supporting service/hook layer.

**Classification model**: `line_of_defense` (integer 1/2/3) is a plain column read directly off six existing Supabase tables — `risks`, `mitigations`, `kris`, `compliance_obligations`, `audit_engagements`, `audit_findings` — no join table. Each row query also pulls type-specific display fields (owner, status, severity, etc.).

**Default-line fallback** (when `line_of_defense` is null), hardcoded per entity type:
- `risks`, `mitigations` → default line 1
- `kris`, `compliance_obligations` → default line 2
- `audit_engagements`, `audit_findings` → default line 3

**View**: a 3-column grid, one `Card` per line, each containing up to six mini-sections (one per entity type) capped at 6 visible rows with a "+N…" overflow indicator.

**Reassignment**: hovering a row reveals `→L1`/`→L2`/`→L3` buttons that call `supabase.from(table).update({ line_of_defense: line, is_edited: true }).eq('id', id)` directly from the client — no backend validation, no permission check beyond whatever RLS exists on the table, and **no record of who reassigned what or when**. The whole page then reloads all six queries.

**A correctness problem worth flagging**: the per-type default mapping is a category error against real IIA doctrine (below). Treating "is this a KRI" as sufficient to default it to line 2 is wrong in general — many KRIs are first-line operational monitoring tools management uses to run the business day-to-day; enterprise-level KRIs a risk function tracks are second-line. A risk register entry isn't "owned" by exactly one line, either: line 1 owns and manages it, line 2 oversees and challenges it, line 3 independently assures it — simultaneously. Fullbloom's schema conflates "which team currently has this record checked out" with the three-lines model's actual subject, which is roles and relationships, not a static per-record tag. This is a real weakness in the precedent, not just a nitpick — it means copying Fullbloom's model wholesale would reproduce a design that misrepresents the framework it claims to implement.

### Current Qiyrix data model

Confirmed via `grep -rn "line_of_defense" aexa-server/prisma/schema/*.prisma` — no matches, concept doesn't exist. The entity types that currently exist and would need a line-of-defense field if this were built:

- `Risk` (`risk.prisma`) — direct equivalent to Fullbloom's `risks`.
- `Kri` (`kri.prisma`) — direct equivalent to Fullbloom's `kris`.
- `Alert` (`alert.prisma`) — system-generated notifications tied to a `Kri`, not itself a governance-owned artifact a human "assigns" to a line.
- `Action` (`action.prisma`) — the closest proxy to Fullbloom's `mitigations`/remediation, though Action is also overloaded to represent audit findings in the current model (see its schema comments distinguishing `ActionResponsible` informational tags from `FindingAssignment` real-authority grants for #52/#55).

Two of Fullbloom's six tagged entity types have **no equivalent at all** in Qiyrix today:
- `compliance_obligations` — doesn't exist; aexa-frontend#93 (Compliance module) is itself still an open "needs product decision" ticket with no backend, per `/Users/omartakadoum/Qiyrix/design-docs/93-compliance-module.md`.
- `audit_engagements` / `audit_findings` — there is no dedicated audit-engagement or audit-finding model. `Inspection` (checklist-driven site inspections) and `Action` (remediation/finding-like items attached to an inspection) loosely cover parts of an audit workflow, but neither maps cleanly onto the IIA audit-engagement lifecycle (planning → fieldwork → opinion) the CDC spec's own audit-module section (lines 1320–1340) describes as the most complex module in the product.

So half of the entity surface this feature would need doesn't exist yet, independent of whether the three-lines concept itself is wanted.

### External research — the real IIA Three Lines Model (2020)

The IIA published **"The IIA's Three Lines Model: An Update of the Three Lines of Defense"** on July 20, 2020 — a deliberate, named retirement of the older "Three Lines of Defense" terminology, not a rename in passing. Getting this right matters here specifically because the product already claims "IIA-IPPF 2024" conformance elsewhere in the spec; using the retired term in-product would be a checkable inaccuracy against that claim.

Structure, per the IIA's own position paper and its "What is the Three Lines Model?" support summary ([theiia.org position paper](https://www.theiia.org/en/content/position-papers/2020/the-iias-three-lines-model-an-update-of-the-three-lines-of-defense/), [IIA support article](https://service.iiacustomersupport.org/support/solutions/articles/153000219369-what-is-the-three-lines-model-)):

- **Governing body** — sits outside and above the three lines, not itself a "line." Accountable to stakeholders for organizational oversight; delegates and directs, but the 2020 update explicitly separates governing-body oversight from operational-line responsibility, correcting a common misreading of the old model that blurred board oversight into "line zero."
- **First line** — management roles that own and manage risk directly in the course of delivering products/services to clients; accountable for maintaining effective internal controls in their own operations.
- **Second line** — management roles (risk management, compliance, quality, IT security, sustainability, and similar functions) that provide complementary expertise, facilitation, monitoring, and challenge related to managing risk — assisting and overseeing first-line risk management, not performing it.
- **Third line** — internal audit, providing independent and objective assurance and advice to the governing body and senior management on the adequacy and effectiveness of governance and risk management, including how well first- and second-line roles achieve risk management and control objectives. Independence from management is the defining structural feature; internal audit reports functionally to the governing body.
- **External assurance providers** — outside all three lines (external audit, regulators) but can supplement them.

The named shift from the old model, confirmed across multiple IIA-affiliated sources ([Chartered IIA](https://charterediia.org/content-hub/articles/new-lines-a-fresh-look-at-the-three-lines-model/), [Internal Auditor magazine](https://internalauditor.theiia.org/en/articles/2020/august/update-the-iia-updates-three-lines-model/)):

- **Principles over structure.** The update frames the model around "roles and relationships — how they may be assigned, combined, and separated," explicitly moving away from rigid, siloed "which line do you belong to" thinking. Functions are expected to collaborate and align, not just guard boundaries.
- **From pure defense to value.** The old model was framed almost entirely around protecting value (defense). The 2020 update reframes it around *both* creating and protecting value — risk-based decision-making includes seizing opportunity, not just avoiding loss.
- **Governing body pulled out cleanly**, as above.
- **Third-line independence reaffirmed explicitly** as a named principle, alongside acknowledgment that third-line functions can also provide consulting services without compromising that independence, provided safeguards exist.

The IIA's own six stated principles of the model (per the position paper's structure) are: (1) Governance, (2) Governing body roles, (3) Management and first- and second-line roles, (4) Third-line roles, (5) Third-line independence, and (6) Creating and protecting value.

**How real GRC platforms actually implement this**: I checked ServiceNow, Diligent, and MetricStream's public materials on the three-lines model. All three treat it as an **organizational/programmatic framework** for structuring GRC roles, responsibilities, and reporting lines — content used to design a GRC *program* (who does what, RACI-style) — not as a literal per-record classification tag with a reassignment UI on individual risk/control/finding rows. I found no public evidence of any mainstream GRC platform (ServiceNow, Diligent, MetricStream, or Archer) shipping a Fullbloom-style "drag this KRI from line 2 to line 1" feature. That's a meaningful signal: the industry pattern is to express line-of-defense through role/permission structure and org design, not through a mutable field on every governance record. Fullbloom's implementation, while a real working precedent, is closer to a hobbyist interpretation of the framework than an established GRC product pattern.

## Should This Be Built At All?

**Recommendation: defer. Don't build now.**

This is explicitly what the issue is asking — a go/no-go call, not an implementation plan — so here's a direct answer with reasoning, not just "here's how you'd build it":

1. **No real internal demand signal.** The CDC spec's only brush with this concept is a single glossary gloss on RCSA. The spec's headline "Conforme IIA-IPPF 2024" claim is never cashed out into a three-lines feature anywhere in ~2,100 lines of otherwise fairly detailed module specs. If this were a planned differentiator, I'd expect at least a paragraph in the audit or governance sections; there is none. Building it now would mean product inventing scope that no internal document, including the one making the loudest IIA-conformance claim, ever asked for.

2. **Foundational entities aren't there yet.** Half of Fullbloom's six classified entity types — compliance obligations and audit engagements/findings — don't exist in the Qiyrix schema, and the Compliance module (#93) is itself still undecided. A governance view spanning "risks, controls, KRIs, compliance obligations, audits, and findings" can only ever cover 2-3 of those 6 categories today (Risk, Kri, and a strained mapping of Action). Building it now means either shipping a visibly incomplete governance view or building compliance/audit-engagement entities as a side effect of a "needs product decision" ticket — sequencing that should run through #93's own decision first.

3. **The one real precedent has a design flaw worth not copying uncritically.** Fullbloom's hardcoded per-entity-type default line, and its unaudited direct-to-Supabase reassignment with no history of who changed what, both work against the actual IIA principles (roles/relationships, not static tags; third-line independence, which implies traceability of judgment calls like this). Copying it as-is would put an IIA-branded feature into a product that claims IPPF conformance while getting a detail of that framework wrong.

4. **It's not baseless scope, either.** Unlike a purely invented feature, the three-lines model is real, well-documented, IIA-endorsed, and directly relevant to the CAE/CRO personas this product targets. If a CAE customer asks "show me our lines of defense," this is a legitimate, well-precedented thing to build — just not yet, and not as a large new page.

**If revisited**, the trigger conditions should be: (a) #93 Compliance module ships, (b) real customer/CAE demand surfaces (a specific ask, not an inferred one from Fullbloom's presence), and (c) it's scoped as the lightweight tag-field approach below, not a new page.

## If Built — Alternatives Considered

**A. Full Fullbloom-parity reassignable matrix view.** A dedicated page, six entity types each carrying a `line_of_defense`-equivalent field, hover-to-reassign UI, 3-column matrix layout.
- Pros: closest to the known working precedent; gives CAE/governance personas a single "who does what" map in one place.
- Cons: needs two entity types that don't exist yet (compliance obligations, audit engagements/findings); perpetuates the entity-as-static-property category error described above; no audit trail on reassignment — a specific, ironic gap for a feature about a framework whose defining third-line principle is independent, traceable assurance; largest effort of the three options and a new nav entry.

**B. Read-only reporting rollup, no reassignment UI.** A report view that groups existing Risk/Kri/Action records by line, computed from ownership/role data (e.g., whether the assigned `OrgMember`'s role maps to first/second/third line) rather than an independently-editable per-record tag that can drift from reality.
- Pros: matches the model's actual "roles and relationships" framing better than a manual tag; avoids maintaining a second, driftable classification alongside real ownership data; no reassignment-authority question to solve.
- Cons: needs the #55 role model to be richer than the current Admin/Lead Auditor/Light user split before a role→line mapping is meaningful; a naive mapping risks being actively wrong in small orgs where the same person plays multiple lines (which the 2020 model treats as normal, not a bug, so a rigid auto-classification could mislabel real setups).

**C. Lightweight tag field on existing entities, no dedicated page.** Add a simple nullable enum field to Risk, Kri, and Action; surface it as an optional filter/column on the existing Risk table, KRI table, and Action board — no new page, no new nav entry.
- Pros: smallest possible slice; reuses existing list/detail UI and existing edit-audit paths rather than inventing a parallel reassignment flow; extensible later into B or A once Compliance/Audit-engagement modules exist and real demand is confirmed.
- Cons: doesn't deliver the unified "governance view" the issue's title implies — a CAE would have to piece the picture together across three separate list views' filters, not get the single-screen rollup Fullbloom's page gives.

## If Built — Recommended Approach

If and when this is greenlit: start with **C**, not A. A tag-only slice de-risks the "does anyone actually use this" question cheaply, avoids inventing the two missing entity types, and avoids shipping a reassignment UI with no audit trail. Revisit **B** (derived, role-based rollup) only after #55's role model matures and #93 ships — at that point a real rollup view becomes cheap to build on top of already-tagged data plus richer role data. Do not build **A**: its unaudited manual reassignment and its per-type default-line logic are specifically the parts of the Fullbloom precedent that don't hold up against the real 2020 model, and reproducing them undercuts a product that markets itself as IPPF-conformant.

## Data Model

```prisma
enum LineOfDefense {
  FIRST
  SECOND
  THIRD
}
```

- `Risk.lineOfDefense LineOfDefense?` — nullable, no default. (Unlike Fullbloom, don't silently default null to line 1 — an unclassified risk should render as "unclassified," not silently misrepresented as first-line.)
- `Kri.lineOfDefense LineOfDefense?` — nullable, no default, same reasoning.
- `Action.lineOfDefense LineOfDefense?` — nullable; only meaningful for Actions functioning as mitigations/controls, not every Action (many Actions are simple inspection follow-ups with no governance-classification need).
- `Alert` — no field. Alerts are system-generated from a `Kri`; classification belongs on the parent `Kri`, not duplicated onto every alert it fires.
- No join table. This is a single-valued classification of "which line currently executes/owns this item," not a many-to-many relationship — a flat nullable field matches Fullbloom's own (simple field, not join table) choice, and there's no requirement here that changes that calculus.
- If reassignment-history/audit-trail is later required (recommended if this ever reaches Alternative A), add a small append-only `LineOfDefenseChange` log table (`entityType`, `entityId`, `fromLine`, `toLine`, `changedByOrgMemberId`, `changedAt`) rather than retrofitting a join table — this is the piece Fullbloom's implementation is missing and shouldn't be skipped if reassignment ships.

## API/UI Implications

Kept intentionally light, consistent with Alternative C being the recommended starting scope:

- Add `lineOfDefense` as an optional field on the existing Risk, Kri, and Action create/update Zod validation schemas and Prisma calls — no new routes.
- Add `lineOfDefense` as an optional query filter on the existing `GET /risk`, `GET /kri`, `GET /action` list endpoints.
- UI: add an optional filter dropdown (First/Second/Third/Unclassified) and a small badge/column to the existing Risk table, KRI table, and Action board components. No new page, no new nav entry, no new i18n namespace beyond three enum-label strings.
- Nothing here touches Alert, Inspection, or the not-yet-built Compliance/Audit-engagement models.

## Open Questions for Omar

1. **Go/no-go, directly**: is three-lines classification something a CAE customer has actually asked for, or is this scope inferred purely from Fullbloom's presence? Given the CDC spec's near-silence on it, I'd want a real signal before spending even the small Alternative-C slice.
2. If greenlit, should scope be permanently capped at Risk/Kri/Action, or is the intent to eventually cover audit engagements/findings and compliance obligations once #93 and a real audit-engagement model exist? That changes whether C is a stepping-stone or the whole feature.
3. Terminology: if built, product copy and code should say "IIA Three Lines Model," not "Three Lines of Defense" — the IIA formally retired the latter in 2020, and the product already claims IPPF-2024 conformance elsewhere, so shipping the outdated term would be a specific, checkable inconsistency against that claim, not just a style nit.
4. If reassignment ever ships (Alternative A/B), should it require the same informational-vs-authority split #52 already established between `ActionResponsible` (plain tag) and `FindingAssignment` (approval-gated real authority)? A line-of-defense tag looks informational today, but if it later feeds KRI escalation routing or risk-based audit-plan scoping, it stops being purely informational and the distinction matters.

## Effort Estimate

- **Recommended path (defer):** effort now = none.
- **If later greenlit, Alternative C (tag field only):** XS–S — three nullable enum fields + migration, filter params on three existing endpoints, a badge/filter in three existing list UIs. Comparable to or smaller than the original KRI module (`kri.prisma` is 21 lines).
- **Alternative B (derived rollup):** M — blocked on #55 role-model maturity; needs a role-to-line mapping decision plus a new read-only report view.
- **Alternative A (Fullbloom-parity matrix):** M–L — new page, new nav entry, two new prerequisite entities (audit engagement, compliance obligation), plus reassignment audit-trail work not present in the Fullbloom original. Not recommended at any point without the audit-trail addition.
