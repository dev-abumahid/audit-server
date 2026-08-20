# Site-Level AI Risk Register Generation

**Status:** Design approved, ready for implementation planning
**Date:** 2026-08-20
**Origin:** CEO mockup (French/EU risk-consultant prompt, ~40-60 fixed risks) + Omar's brief (a company's risk lead creates a Site, clicks "Analyze with AI," gets a full, precise, grounded risk register). Reworked significantly from the mockup after codebase research, a live single-call-vs-two-phase test against a real company, and **three** rounds of multi-agent critical review — an initial 5-agent panel (GRC/compliance, engineering, product/UX, security, devil's-advocate) against the conceptual design, a second 3-agent pass (completeness/consistency, implementability cross-checked against the real codebase, a second devil's-advocate round) against this written document itself, and a third 4-agent pass scoped specifically to whether/how to verify AI-generated regulatory citations (see §10).

This **fully replaces** the existing `analyze_site_risks_with_ai` feature (6-10 risks, single call, no regulatory grounding, no financial ranges) for its main entry point (the Sites page "Analyze with AI" button). The existing single-call `/risk_analysis` endpoint stays alive for the *separate*, structurally different zero-input onboarding flow (see §9) — it is not deleted, just no longer the Sites-page feature.

**Scope note (added after the second review round):** the org-level threshold subsystem (Phase 1.5, auto-detecting Sapin II/Devoir de Vigilance) and the audit-scheduling field cluster (`audit_frequency`/`audit_next_due_date`/`audit_sign_off_role`/`linked_audit_id`) described in earlier drafts of this doc are **cut from this version and deferred** — see §8 for why. Everything else below reflects the current, revised scope.

---

## 1. What already existed (context, not spec)

Before this design, Qiyrix already had:
- Site model: `name`, `location`, `country`, `activity`, `revenue`, `employees_count`, `site_type` — 6 of 7 fields the CEO's mockup wanted. Only `description` was missing.
- An "Analyze AI" button on the Sites page → `POST /ai/analyze-site-risks` → aexa-ai's `/risk_analysis` endpoint → one OpenAI structured-output call → 6-10 risk suggestions, no persistence, reviewed via a flat checkbox list, bulk-imported via the existing `createNewRisk` path.
- A near-identical 20-category taxonomy already matching the CEO's 19.
- Existing_risks dedup by title+category, already working.
- A separate, existing "Regulatory Coverage" feature that grounds citations in live Tavily search results, with a proven `<user_input>`-wrapping prompt-injection defense and a `_safe_source_url` sanitizer.
- Server-side numeric clamping precedent (`risk_field_suggestion_service.py`), fixed after a real production incident where an AI-suggested unbounded field corrupted a financial calculation.

None of this is thrown away — the new design reuses the taxonomy, the dedup concept, the injection-defense pattern, and the clamping precedent directly.

## 2. Validated architecture decision: two-phase generation

**Tested empirically** (not assumed) against a real company: Fives Nordon, Nancy, France (industrial piping/pressure-vessel fabrication, welding, induction bending, 1100°C heat treatment, COFRAC-accredited NDT lab — verified via web research, not invented).

| | Single-call | Two-phase |
|---|---|---|
| Wall-clock time | 121.4s | 35.1s (8.4s triage + 26.8s parallel generation) |
| Risks generated | 29 | 116 |
| Categories covered | Uneven; invented an off-taxonomy `"quality"` category | 16 of 20, cleanly enum-constrained |
| Parallel-call failures | n/a | 0 of 16 |

Two-phase won on every axis — faster **and** more complete, not a quality-for-latency tradeoff. Single-call's 121s also confirmed it's a non-starter for a synchronous UX regardless of quality. **Decision: build two-phase.**

The test also surfaced two concrete tuning findings to carry into implementation:
- Each Phase 2 call generated ~1.8x more than its own triage estimate ("use your judgment" is currently too permissive) — **the concrete fix, made explicit here after the second review round flagged this as named-but-not-specified**: the Phase 2 prompt must instruct the model to generate within roughly 0.5x-1.5x of `estimated_risk_count` for that category, exceeding that band only with an explicit one-line justification in the response. This is a soft band, not a hard cap — genuinely complex categories can still justify going over — but it stops the unconstrained "use your judgment" phrasing from defaulting to over-generation the way it did in testing.
- The single-call variant emitted a category (`"quality"`) outside the fixed 20-value taxonomy. **Category must be a strictly server-validated enum, never trusted free text from the model**, regardless of which architecture — this was already a known risk from the security review; the test made it concrete.

The test also validated the regulatory-grounding design directly: real generated output included *"Misapplication of pending NIS2 requirements"* (correctly treating NIS2 as not-yet-binding per the curated framework's `legal_status`) and a correctly-cited Loi Waserman risk (the framework the research found missing from the CEO's original mockup).

### Architecture

```
Analyze with AI click
        │
        ▼
Phase 1: Triage (1 LLM call, ~8s)
  Input: site profile (name, location, country, activity, employee count,
         site type, description)
  Output: for each of 20 fixed categories — applies (bool), reasoning,
          estimated_risk_count
        │
        ▼
Phase 2: Focused parallel generation (N LLM calls, one per category
          triage flagged `applies: true` — ~27s wall-clock for 16 parallel
          calls in the validation test)
  Input per call: site profile, curated RegulatoryFramework reference
                  (static-first in the prompt for cache reuse — see §7),
                  that category's estimated_risk_count (generate within
                  ~0.5x-1.5x of this, see the tuning note above), existing
                  risks at this site for dedup
  Output: that category's real, applicable risks for this site
        │
        ▼
Results stream into the review UI as each category call completes
(not held until all N finish — see §6)
```

(An earlier draft included a "Phase 1.5" deterministic org-level threshold check here, for auto-detecting group-wide obligations like Sapin II. Cut from this version — see §8.)

## 3. Data model changes

### Risk (new fields)

| Field | Type | Notes |
|---|---|---|
| `legal_status` | enum: `active_statutory \| pending_statutory \| conditional_statutory \| recognized_standard \| voluntary_best_practice` | Replaces a flawed binary "Nature: mandatory/voluntary" — the research showed at least these 4 real states exist (NIS2 is real law but not yet French-binding; Sapin II is real law but threshold-gated; APSAD/NF C 18-510 are private standards, not law). A simple "Mandatory/Voluntary" badge is *derived* from this in the UI (active/pending/conditional → "Mandatory"; recognized_standard/voluntary → "Voluntary"), not separately stored, so the two can't drift out of sync. |
| `regulatory_framework_id` | nullable FK → `RegulatoryFramework` | Set only when the AI cites a curated, verified framework. Server must validate this against the real curated table before persisting — never trust the model's citation even though it's schema-typed as a valid FK shape (see §7). |
| `regulatory_citation_note` | nullable string | Fallback for a defensible-but-uncurated citation (e.g. a live-search result, see §5) — never a fabricated article number; general framing only if uncertain. |
| `citation_confidence` | enum: `curated_verified \| ai_estimate \| none` | **Both the GRC and UX reviewers independently flagged this as the single most important trust signal.** Must be a persisted, stored field (not derived/inferred client-side), and must survive as a permanent, visible marker on the Risk detail view after import — not just during the review step. |
| `internal_pilot` | nullable string | Free text (per Omar's decision — AI suggests a role hint like "HSE Manager," a human fills in the real name; no FK to a real user, no notification system). |
| `ai_generation_run_id` | nullable FK → `AiRiskAnalysisRun` | Provenance — see below. Must persist through edits to the risk (an edit updates the row; it must not erase where the risk came from). Existing `ai_generated: Boolean` and `source_info: String?` fields (already on `Risk` today, `risk.prisma`) stay set exactly as they are for any other AI-originated risk — this new FK adds detailed provenance, it doesn't replace those two. |

`financial_impact_min`/`financial_impact_max` already exist — this feature just starts actually populating them with real k€ numbers instead of the old vague qualitative text. Server-side clamp bounds reuse the existing validated range: `0` to `1_000_000` (k€), the same bound `risk.validation.ts`'s `create_risk` schema already enforces today (fixed earlier this session after an unbounded value corrupted the EBITDA-at-risk calculation) — no new range to invent.

**Cut from this version** (see §8 for why): `scope` (site/organization), `audit_frequency`, `audit_next_due_date`, `audit_sign_off_role`, `linked_audit_id`, and the `OrganizationProfile` headcount/revenue additions that would have fed a Phase 1.5 org-threshold check. An earlier draft of this doc specified these; the second review round found real, concrete problems with each (see §8) that are better resolved by deferring than by shipping underspecified.

**What does *not* change:** `inherent_score`/`residual_score` remain exclusively server-derived from probability×impact and control-effectiveness (the exact rule fixed hours earlier tonight for the manual form — the bulk-import path must go through the same derivation, never let AI-set values bypass it). `pagerank_score` remains a separately-computed graph-centrality metric, untouched by this feature. Every newly-imported risk defaults `status: "open"` regardless of what the AI might imply — a freshly-generated, unreviewed risk cannot credibly claim "under control."

### New: `RegulatoryFramework`

DB-backed, not a static config file (Omar: "don't cheap out, do it right from the start"). Seeded from verified research (18 real French/EU frameworks — see §5). Admin-editable, with real audit trail (who changed what, when) since this is compliance-sensitive content a customer's own auditor may eventually ask about.

| Field | Type |
|---|---|
| `id` | uuid |
| `name` | string |
| `official_reference` | string (e.g. "Règlement (UE) 2023/1230") |
| `jurisdiction` | string |
| `domain` | string |
| `legal_status` | same enum as `Risk.legal_status` |
| `applicability_threshold` | nullable structured field — e.g. `{ "min_employees": 500, "min_revenue_eur": 100_000_000 }` for Sapin II, or `{ "min_employees_france": 5000, "min_employees_worldwide": 10000 }` for Devoir de Vigilance, null for universal frameworks like DUERP/RGPD |
| `summary` | text |
| `source_url` | nullable string |
| `last_verified_at` | date |
| `updated_by` / `updatedAt` | audit trail |

### New: `AiRiskAnalysisRun`

Provenance record for one "Analyze with AI" click, so a permanent link survives past the review step (per the UX review's finding #5 — a future auditor needs to be able to tell "we manually assessed this" from "AI suggested this and we accepted it," months later).

| Field | Type |
|---|---|
| `id` | uuid |
| `site_id`, `org_account_id`, `triggered_by_account_id` | scoping/audit |
| `started_at`, `completed_at` | |
| `status` | `running \| completed \| partial \| failed` |
| `triage_result` | json (the Phase 1 output, kept for auditability) |
| `categories_applicable`, `categories_skipped` (with reasons), `categories_failed` | json |

## 4. Generation prompt design

**Regulatory grounding:** hybrid, per Omar's earlier decision. Every Phase 2 call's prompt embeds the full curated `RegulatoryFramework` reference (static-first, for prompt-cache reuse — see §7) with an explicit instruction: cite ONLY from this list, respect `legal_status` exactly (e.g. never cite NIS2 as an active obligation while it's `pending_statutory`), and for any framework carrying an `applicability_threshold` (Sapin II, Devoir de Vigilance, CSRD — see §5), do not assert it applies without real evidence the site/org clears that threshold — since there's no automated org-wide headcount check in this version (see §8), the model should default to `legal_status: conditional_statutory` framing with the threshold stated in the risk description, not a confident "this applies" citation. Use `citation_confidence: ai_estimate` or `none` rather than inventing an article number when nothing curated matches. The secondary live-search "find citation" fallback (reusing the existing Tavily-grounded pattern from Regulatory Coverage) is a **separate, on-demand, per-risk action** the user can trigger later — not part of the synchronous Analyze flow, so it never adds unpredictable latency to the main click.

**Risk volume:** no fixed target. A floor (~20-25) for genuinely complex sites, no cap, and categories that genuinely don't apply are skipped, not padded — the validation test proved a complex real site can legitimately produce 100+ risks once tuned, so the floor is a safety net against a thin-looking register, not a target to force.

**Category taxonomy:** the same 20 fixed values already in the app (`supply_chain`, `financial`, `regulatory`, `cyber`, `operational`, `hr`, `strategic`, `ehs`, `geopolitical`, `natural_disaster`, `technology`, `reputational`, `compliance`, `ai_emerging`, `fire`, `electrical`, `atex`, `machine_safety`, `environmental`, `security_physical`) — **server-validated as a strict enum**, any off-list value from the model rejected/coerced, closing the `"quality"` drift the validation test caught.

**Existing app enums the prompt must target exactly** (verified from `RiskFormModal.tsx`, not assumed):
- `velocity`: `critical | high | medium | low`
- `trend`: `increasing | decreasing | none`
- `status`: always `open` on import, regardless of AI output

**Explicit narrow-gating instructions** (from GRC review, both independently flagged as easy to over-trigger): CBAM/MACF only for confirmed importers of the specific listed carbon-intensive goods, never from generic "international supply chain" language; Dual-Use export controls only for confirmed defense-adjacent/advanced-electronics/specialized export activity, never from generic "Technology" or "AI & Emerging" category pattern-matching.

## 5. Curated `RegulatoryFramework` seed data

18 entries, verified via live web research (August 2026) against the CEO's original mockup, with corrections:

| Framework | `legal_status` | Threshold | Correction from mockup |
|---|---|---|---|
| DUERP (Code du travail R.4121-1) | active_statutory | none (universal, ≥1 employee) | — |
| Pénibilité/C2P | active_statutory | sector-specific | Narrowed to 6 factors (2018 reform) |
| ICPE (Code environnement R.511-9) | active_statutory | site-specific nomenclature lookup | — |
| ATEX (2014/34/UE + 1999/92/CE) | active_statutory | narrow (explosive atmospheres only) | — |
| RGPD (2016/679) | active_statutory | none (universal) | — |
| **NIS 2 (2022/2555)** | **pending_statutory** | sector/size once transposed | **Mockup implied active — not yet transposed in France as of Aug 2026 (EU referred France to CJEU 8 July 2026)** |
| Loi Sapin II (2016-1691) | conditional_statutory | ≥500 employees AND >€100M revenue | **Mockup implied broad applicability — actually narrow to large groups** |
| **EU Machinery Regulation (2023/1230)** | **pending_statutory** | full application 20 Jan 2027 | **Mockup cited as current — not fully in force until 2027** |
| CBAM/MACF (2023/956) | active_statutory (since Jan 2026) | specific imported goods only | — |
| Dual-Use export controls (2021/821) | active_statutory | defense-adjacent/advanced electronics only | — |
| **CSRD (2022/2464)** | conditional_statutory | >250 employees, >€50M revenue, >€25M balance sheet | **Mockup didn't reflect the "Stop the Clock" delay — most mid-sized companies now report FY2027-2029, not "now"** |
| EU AI Act (2024/1689) | active_statutory (phased) | AI-deploying sites | Calendar shifted July 2026 |
| Devoir de Vigilance (2017-399) | conditional_statutory | ≥5,000 France / ≥10,000 worldwide | **Mockup implied broad — actually very large groups only** |
| **Electrical safety** | active_statutory (Code du travail R.4544-x) | universal | **Mockup cited NF C 18-510 as "the code" — it's a private recommended standard, not law; the actual legal obligation is the Code du travail articles** |
| **Fire safety (Code du travail R.4227-1+)** | active_statutory | universal | **Mockup cited APSAD referentials as law — they're private insurer standards, not statutory** |
| VGP periodic inspection (R.4323-23+) | active_statutory | universal (lifting/handling equipment) | — |
| **Trackdéchets** | active_statutory | universal (hazardous-waste producers) | **Missing from mockup entirely — mandatory from 1 September 2026, essentially imminent** |
| **Loi Waserman whistleblowing (2022-401)** | active_statutory | ≥50 employees | **Missing from mockup entirely** |

## 6. Review/import UX

- **Progressive results via polling, not SSE.** SSE has zero precedent anywhere in this codebase (confirmed by grep — no `EventSource`/`text/event-stream` usage anywhere). RTK Query polling against a status field is a proven, twice-shipped pattern here: `KnowledgeBaseUploadingForm.tsx` (`useCheckUploadFileStatusQuery(fileId, { pollingInterval: 2000 })`) and `ReportsPage.tsx` (reactive polling toggled by any row being `GENERATING`). Copy this exact shape against `AiRiskAnalysisRun.status` — same-day implementation, not new infrastructure. First results visible within ~10s, not a 35s dead-air wait.
- **Coverage-framed header, never a bare count.** "Analyzed 18 of 20 categories · 2 not applicable to this site" with the skipped categories and their one-line reasoning shown — converts a lower-than-mockup count into a legible, trust-building signal ("the AI reasoned about scope") instead of reading as underperformance.
- **Grouped by category**, collapsed by default, mandatory-before-voluntary sort within each. Category header shows live counts as items are actioned.
- **Citation confidence is a first-class visual badge** (curated-verified / AI-estimate / none), not buried in row text — this is the exact trust distinction that made the CEO's own mockup risky (confident-looking but sometimes-wrong citations) and it must be impossible to miss while scanning 40+ rows.
- **Scoped fast-path bulk-accept**: eligible only if ALL of: `legal_status` is `active_statutory` or `conditional_statutory` (i.e. reads as "Mandatory"), `citation_confidence` is `curated_verified`, AND `financial_impact_max` ≤ 50 (k€). Anything voluntary, uncited/AI-estimated, or above that impact ceiling requires an individual touch. This directly guards against "trust fatigue" at higher volume — the exact failure mode the UX review named as the single biggest abandonment risk. **Caveat carried over from the second review round**: this exact rule (including the €50k cutoff) is a reasoned default, not an empirically-tested one — the two-phase-vs-single-call architecture was validated with a real test; this UX rule hasn't been. Before finalizing the exact thresholds, run a short moderated walkthrough with 2-3 real GRC/risk-lead users against actual generated output (the Fives Nordon test data works for this) and adjust based on what they actually bulk-accept vs. individually review.
- **Permanent provenance marker** on the Risk detail view post-import ("Sourced: AI analysis, [date] · run link"), surviving future edits to the risk. Retrying a failed category (see §7) updates the *same* `AiRiskAnalysisRun` row rather than creating a new one — risks from the retry link to that same run id, so provenance stays attributable to one coherent "analysis" even if part of it needed a retry.
- **Re-analysis dedup, two layers with distinct jobs**: the "existing risks at this site" list included in every Phase 2 prompt (§2) is a *soft hint* to reduce redundant generation — it doesn't guarantee anything. The actual enforced dedup happens server-side at review/import time: `(category, regulatory_framework_id)` as the primary key where a citation exists (a stable anchor, unlike free-text titles); for uncited risks, embedding-similarity on name+description (cosine similarity above a threshold, tuned empirically once real re-analysis data exists — start conservative, e.g. 0.9, and loosen only if real usage shows too many false "duplicates" being suppressed) rather than title-string matching alone. Never silently re-inject a previously-dismissed suggestion (existing behavior, preserved).
- **Re-run cooldown**: 10 minutes per site, visible in the UI ("last analyzed X ago") — caps the cost-abuse vector the engineering review flagged, cheaper and more targeted than a model-tier downgrade.

## 7. Engineering / robustness requirements

**The first three items below are prerequisites for shipping Phase 2 safely, not late-stage polish** — flagged explicitly after the second review round noted this section's position (after the UX section) could otherwise read as optional cleanup. Org-scoping, output validation, and category-enum enforcement must exist before Phase 2 is considered done, not added afterward.

- **Server-side output validation, regardless of schema typing.** Reuse the existing `_clamp`-style pattern (`risk_field_suggestion_service.py`, already fixed once after a real production incident) for every numeric field (`probability`, `impact`, `financial_impact_min/max` — clamped to the existing `0`-`1_000_000` k€ bound from `risk.validation.ts`, `control_*_eff`), and extend the same discipline to the category enum (closing the `"quality"` drift found in testing) and to `regulatory_framework_id` (validate server-side against the real curated table before persisting — never trust the model's citation even if the schema is well-formed).
- **Explicit org-scoping for every parallel call's dedup query** — thread a single `resolveCallerOrgContext` result through all N parallel Phase 2 calls' existing-risk lookups, not re-derived independently per call from a bare `site_id`. Per `aexa-server/CLAUDE.md`'s org-scoping table, `Risk` uses `org_account_id` (snake_case) — verify this exact field name at implementation time, field naming is inconsistent across models in this codebase.
- **Cap `description`/`activity` field length at 2,000 characters** before they reach any prompt — the single most realistic failure mode identified in review isn't a malicious attacker, it's a long, legitimately-authored corporate description containing instructional-sounding language ("per our internal policy, X is handled separately") that gets duplicated into all N parallel calls at once and could bias the whole run in a way no single reviewer would catch scanning one category at a time. 2,000 characters is generous for a genuine site description while still bounding worst-case prompt size across N parallel calls.
- **Partial-failure handling, explicit contract.** Each Phase 2 category call tracked independently (`pending`/`success`/`failed`) on the `AiRiskAnalysisRun` row; successful categories persist as they complete, not buffered until all finish. On completion, any failed categories surface explicitly ("3 of 16 categories could not be analyzed: Cyber, ATEX, Fire — Retry") with a scoped retry limited to just those categories, updating the same run row (see §6). **Never silently drop a category** — for a risk register, an unlisted category reads as "no risk here" to an auditor, the worst possible failure mode for this specific product.
- **Prompt caching**: the curated `RegulatoryFramework` reference block must be structured static-first (byte-identical prefix across every call, every category, every site) with a cache breakpoint, so repeated Phase 2 calls actually benefit from OpenAI prompt caching rather than defeating it via naive per-call string interpolation. Fire the N parallel calls with a small stagger (~300ms between each) rather than a separate pre-warm call — simpler, no extra API call, and simultaneous parallel calls can't read each other's cache anyway (only a call that began streaming first benefits later calls).
- **New free-text fields need export-path hardening before shipping**: confirmed, not hypothetical — `report_pdf.ts` (Puppeteer HTML-to-PDF) and `useRiskCsvExport.ts` are real, existing Risk-data export paths. `internal_pilot` and `regulatory_citation_note` are new AI-generated free text and won't automatically inherit whatever escaping older fields have — verify/add HTML-escaping before Puppeteer rendering and CSV-formula-injection guarding (leading `=`/`+`/`-`/`@`) before shipping either field.
- **Live-search citation fallback** must reuse the exact `prompt_data_block`/`prompt_user_input` wrapping the existing `regulatory_coverage_service.py` already applies correctly to fetched search-result content, not a new, unwrapped concatenation.

## 8. Explicitly out of scope / deferred, and why

- Real assignable risk owners (linked to actual org users, with notifications) — Omar's call: free text only, matching the mockup.
- Non-French/EU jurisdictions — explicitly France/EU-focused per Omar's answer; a global version is a distinct future project, not a phase of this one.

**Deferred after the second review round, with concrete reasons (not just "simpler"):**

- **Org-level threshold subsystem** (Phase 1.5, auto-detecting Sapin II/Devoir de Vigilance applicability, the `scope: site|organization` Risk field, `OrganizationProfile` headcount/revenue fields). Cut for three real reasons found during review, not just scope discipline:
  1. **It requires a schema change bigger than it looks.** `Risk.site_id` is a `NOT NULL` FK with `onDelete: Cascade` today (`risk.prisma`) — `scope: organization` risks having `site_id = null` isn't a one-line addition, it's a nullability change that needs a query-layer audit across every existing service that assumes a risk always has a site (list views, exports, reports, dedup).
  2. **Both gating regulations are large-cap-only** (Sapin II: ≥500 employees AND >€100M revenue; Devoir de Vigilance: ≥5,000 France/≥10,000 worldwide) — there's no confirmation Qiyrix's actual customer base includes companies at that scale yet. Building an org-wide threshold-tracking subsystem for regulations that may not fire for any real customer soon is speculative infrastructure.
  3. The other 16 curated frameworks (DUERP, ICPE, ATEX, RGPD, NIS2, CBAM, CSRD, AI Act, fire/electrical safety, VGP, Trackdéchets, Loi Waserman) carry the real demonstrated value — the validation test's generated output cited several of these correctly with no org-threshold logic involved at all.

  **What ships instead in this version**: Sapin II and Devoir de Vigilance stay in the curated `RegulatoryFramework` table (§5) for reference completeness, but the generation prompt is instructed to frame them as `conditional_statutory` with the threshold stated in the risk description rather than asserting applicability (§4) — informative, not falsely confident, with no schema change required.

- **Audit-scheduling field cluster** (`audit_frequency`, `audit_next_due_date`, `audit_sign_off_role`, `linked_audit_id`). Cut for two real reasons:
  1. **`linked_audit_id`'s target is ambiguous and conflicts with existing relations.** There is no single `Audit` model — `Inspection.riskId` and the `AuditEngagementRisk` join table both already relate `Risk` to audit-adjacent concepts, in the *opposite* direction from what a new `Risk.linked_audit_id` FK would need. Which of these a new field should point at (or replace) is a real design decision this doc hasn't made, not a naming detail.
  2. **The consuming workflow doesn't exist yet.** As the second devil's-advocate round put it: shipping `audit_frequency`/`audit_next_due_date` as AI output before real audit-linkage UX is designed means these fields sit unused/unlinked in the UI — exactly the "decorative metadata disconnected from the app's actual audit trail" risk the first review round already flagged, except shipped anyway.

  This cluster is a natural, coherent follow-up project once the audit-linkage workflow is actually designed — it's a real GRC need, just not one this version should ship half-built.

## 9. Migrating/removing the existing feature

The implementability review cross-checked the "fully replaces" claim against the real codebase and found more surface area than the earlier draft acknowledged. Two things to handle explicitly during implementation, not discover mid-PR:

**The existing single-call `/risk_analysis` endpoint has a second, independent caller.** `onboarding.service.ts` calls it directly during zero-input org-creation (stages 1-3), *before* an `Organization` row exists — structurally incompatible with the new flow's org-scoped, two-phase design. **Decision: keep the existing single-call endpoint alive specifically for onboarding.** It is not deleted — only the Sites-page "Analyze with AI" button is repointed at the new two-phase flow. Onboarding is out of scope for this redesign entirely.

**The current feature's review/import surface is larger than "a checkbox list" and needs explicit removal, not just replacement:**
- `AiSuggestionState` Prisma model + its full CRUD module (route/service/validation)
- `aiSuggestions.slice.ts` (Redux) and `aiSuggestions.api.ts` (RTK Query)
- The fingerprint-dedup util and its test file (`aiSuggestionFingerprint.ts`)
- `SitesEntities.tsx`'s existing "Analyze AI" review UI (state, selection, bulk-import) and its test file

All of this is genuinely dead once the new flow ships (the new `AiRiskAnalysisRun`/review-UX design in §3/§6 replaces it outright) — it should be deleted as part of this feature's implementation, not left dangling as unused code. Grep for `AiSuggestionState`, `aiSuggestions`, and `aiSuggestionFingerprint` across all three repos at implementation time to find every reference before deleting.

## 10. Citation verification — what ships now vs. what's designed but deferred

Prompted by a direct question: should a second AI pass adversarially double-check a risk's `citation_confidence: curated_verified` claim, rather than trusting the generating call's own self-assessment? A 4-agent review (architecture/cost, verification-prompt design, review UX, and a dedicated cost-benefit skeptic) worked this through in full. Three of the four independently designed a genuinely solid adversarial verification pass; the fourth made a sharper point the other three hadn't been asked to weigh: the single highest-stakes version of this problem doesn't need an LLM at all.

### Ships now: a deterministic threshold check (extends §7's existing validation)

The frameworks in the curated table that carry a non-null `applicability_threshold` (Sapin II, Devoir de Vigilance, CSRD — see §5) are exactly the cases where "does this genuinely apply" isn't a judgment call, it's arithmetic: `site.employees_count >= threshold.min_employees AND site.revenue >= threshold.min_revenue_eur`. Both fields already exist on `Site` today.

**Add to the server-side validation §7 already mandates**: after a Phase 2 risk citing a threshold-bearing `regulatory_framework_id` is generated, check the site's actual data against `applicability_threshold` in code, before persisting. If the threshold isn't clearly met, force `legal_status` to `conditional_statutory` and cap `citation_confidence` at `ai_estimate` — regardless of what the generating call itself asserted. This upgrades the current mitigation (§4's prompt instruction "don't assert applicability without evidence," which is itself just an LLM being trusted to behave — the same category of risk a verification pass exists to catch, one layer up) from a prompt hint to actual, auditable code. Near-zero cost, no new prompt, no new model call, no new UI state — a GRC auditor can read the check itself rather than trust a probabilistic verdict.

### Deferred, fully designed for when it's needed: adversarial LLM verification

The one real evidence point available — the Fives Nordon validation test (§2) — found **zero** citation-accuracy failures; it correctly downgraded NIS2 to pending and correctly cited Loi Waserman unprompted. Building a second orchestration layer, a new prompt to maintain, new cost (~20 calls / <$1 per analysis), and new UI states to fix a failure mode not yet observed, on a feature that hasn't shipped v1 yet, is solving a hypothetical ahead of a real one — the same "no evidence of need yet, real complexity cost" bar that got the org-threshold subsystem and audit-scheduling fields deferred in §8. This is deferred for the identical reason.

The design is fully worked out and ready to build the moment real usage shows a genuine gap (specifically: wrong citations on *non*-threshold frameworks — domain-fit mismatches like ATEX cited without an explosive-atmosphere process — since the deterministic check above already closes the threshold-gated case):

- **Timing**: asynchronous, after Phase 2 results are already visible — not synchronous, which would erode the 121s→35s win that made the synchronous UX viable in the first place (§2).
- **Granularity**: one verification call per *category* (batching all of that category's `curated_verified` claims), not per risk — caps calls at ≤20 instead of 20-60+, and lets a category-level check catch a pattern a per-risk call can't see (e.g. one framework over-applied across several risks in the same category).
- **Independent pass, not folded into Phase 2 as self-critique**: the same completion-momentum bias that makes proofreading your own writing five minutes after typing it unreliable applies here — a genuinely separate context, framed adversarially from the start, doesn't inherit the generating call's bias toward agreeing with itself.
- **Single verifier, not an N-skeptic voting panel**: unlike the open-ended judgment calls this project's own review rounds used a panel for, citation-fit is checked against a fixed, already-curated rubric — low legitimate variance across repeated calls, and the dominant failure mode (systematic over-assertion, not random hallucination) isn't one voting averages away.
- **Cheaper model tier**: a bounded classification task (confirm/refute against provided facts), not open generation — doesn't need the same capability tier as Phase 2, though this should be validated against the real Fives Nordon output before committing, not assumed.
- **The safeguard that makes it trustworthy rather than theater**: a verdict of `REFUTED` is only valid if the model names one of five specific mismatch types (threshold not evidenced / domain mismatch / legal-status overstated / narrow-gate violation / reference inconsistency) *and* quotes the specific conflicting fact — enforced server-side after the call returns, same discipline as the existing `_clamp` pattern (§7). A refutation with vague reasoning ("seems uncertain") is rejected, not acted on.
- **On a valid refutation**: a new `citation_confidence: flagged_for_review` state (distinct from `ai_estimate` — a refuted claim is a negative signal, not a neutral absence of one), `regulatory_framework_id` stays set so the reviewer can judge the specifics themselves, and the one-line refutation reasoning surfaces inline on the risk row.
- **UX integration**: no blocking spinner or global progress line — verification-pending rows just show a subtle pending micro-state and are excluded from the fast-path bulk-accept eligible set until resolved (closing the exact race condition — bulk-accepting a citation whose check hasn't finished — that motivated the question). Manual, individual accept is never blocked.

### Appendix: verification prompt skeleton (for when this is built)

```
SYSTEM:
You are a skeptical compliance verifier. Your only job is to check whether
ONE specific regulatory citation, already made by another AI system, holds
up under scrutiny. You are not evaluating the risk's severity, category, or
overall quality — only whether this specific citation is sound.

Your default posture is skeptical, not agreeable: a citation to a curated,
human-verified framework is a strong claim, and it is your job to actively
look for reasons it doesn't hold, not to confirm it sounds plausible.

You may only return a verdict of REFUTED if you can name ONE of the five
specific mismatch types below AND cite the specific conflicting fact from
the data provided. General uncertainty, "hard to verify," stylistic
disagreement, or disagreement with anything other than the citation itself
(severity, category, wording) is NOT grounds for refutation — if that is
all you find, you must return UPHELD.

Mismatch types (choose exactly one if refuting):
1. THRESHOLD_NOT_EVIDENCED — the framework has an applicability_threshold
   and the site profile does not contain facts meeting it.
   (Note: for threshold-bearing frameworks, the deterministic check
   described above already runs first — this call only sees a citation
   that already passed that check, or targets a non-threshold framework.)
2. DOMAIN_MISMATCH — the risk's actual subject matter is not what the
   framework's domain/summary govern.
3. LEGAL_STATUS_OVERSTATED — the risk's description or legal_status frames
   a pending_statutory or conditional_statutory framework as a current,
   unconditional, binding obligation.
4. NARROW_GATE_VIOLATION — (CBAM/MACF or Dual-Use only) the site profile
   lacks the specific confirming fact the framework's narrow scope requires.
5. REFERENCE_INCONSISTENCY — the risk states a reference/jurisdiction detail
   that contradicts the curated framework row.

Respond ONLY with the JSON schema provided. Do not add commentary outside it.

USER:
## Generated risk (citation to check)
name: {risk.name}
category: {risk.category}
description: {risk.description}
reasoning: {risk.reasoning}
asserted_legal_status: {risk.legal_status}
asserted_citation_confidence: {risk.citation_confidence}

## Curated framework cited (ground truth — verbatim, do not paraphrase)
name: {framework.name}
official_reference: {framework.official_reference}
jurisdiction: {framework.jurisdiction}
domain: {framework.domain}
legal_status: {framework.legal_status}
applicability_threshold: {framework.applicability_threshold | "none (universal)"}
summary: {framework.summary}
last_verified_at: {framework.last_verified_at}

## Site profile (facts available to check applicability against)
activity: {site.activity}
employees_count: {site.employees_count}
revenue: {site.revenue}
site_type: {site.site_type}
country: {site.country}
description: {site.description}   # capped 2,000 chars, same as generation prompt

## Task
Check this citation against the five mismatch types above, in order.
Stop and return REFUTED at the first one that concretely applies. If none
apply, return UPHELD.

## Output schema (JSON only)
{
  "verdict": "UPHELD" | "REFUTED",
  "mismatch_type": "THRESHOLD_NOT_EVIDENCED" | "DOMAIN_MISMATCH" |
                    "LEGAL_STATUS_OVERSTATED" | "NARROW_GATE_VIOLATION" |
                    "REFERENCE_INCONSISTENCY" | null,
  "specific_evidence": string | null,   // required, non-generic, if REFUTED;
                                         // must quote/reference an actual
                                         // field value from above
  "reasoning_summary": string           // one or two sentences, shown to
                                         // the human reviewer verbatim if
                                         // REFUTED
}
```

**Server-side enforcement after the call returns** (not in-prompt — belongs in the calling service, same as every other output-validation rule in §7): reject/treat-as-UPHELD any response where `verdict == REFUTED` but `mismatch_type` is null or `specific_evidence` is empty/generic (matches a denylist of vague phrases like "unclear," "uncertain," "hard to say"). Log a warning for prompt-tuning review rather than silently passing through — a model that returns malformed refutations repeatedly signals the prompt needs tightening, not that the check should be trusted anyway.

Batching note: when built, this runs once per category (not per risk) against that category's full set of `curated_verified` risks — the skeleton above shows the single-risk shape for clarity; the batched version repeats the "Generated risk" + "Curated framework cited" blocks per risk in the same call and returns an array of verdicts.
