# Site-Level AI Risk Register Generation

**Status:** Design approved, ready for implementation planning
**Date:** 2026-08-20
**Origin:** CEO mockup (French/EU risk-consultant prompt, ~40-60 fixed risks) + Omar's brief (a company's risk lead creates a Site, clicks "Analyze with AI," gets a full, precise, grounded risk register). Reworked significantly from the mockup after codebase research, a live single-call-vs-two-phase test against a real company, and a 5-agent critical review panel (GRC/compliance, engineering, product/UX, security, devil's-advocate).

This **fully replaces** the existing `analyze_site_risks_with_ai` feature (6-10 risks, single call, no regulatory grounding, no financial ranges). There is no incremental v1 — the new architecture ships as the only version.

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
- Each Phase 2 call generated ~1.8x more than its own triage estimate ("use your judgment" is currently too permissive) — tighten this in the real prompt so output tracks closer to the triage estimate rather than over-generating.
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
Phase 1.5: Org-level threshold check (deterministic, NOT an LLM call)
  Input: org's tracked total_employees / total_revenue / worldwide_employees
         (see §4), curated RegulatoryFramework.applicability_threshold rows
  Output: creates/updates org-SCOPED risks (e.g. Sapin II, Devoir de
          Vigilance) if the org's real numbers cross the threshold —
          exact arithmetic against exact legal numbers, never LLM judgment
        │
        ▼
Phase 2: Focused parallel generation (N LLM calls, one per category
          triage flagged `applies: true` — ~27s wall-clock for 16 parallel
          calls in the validation test)
  Input per call: site profile, curated RegulatoryFramework reference
                  (static-first in the prompt for cache reuse — see §7),
                  that category's estimated_risk_count, existing
                  site-scoped risks for dedup
  Output: that category's real, applicable, SITE-scoped risks only
        │
        ▼
Results stream into the review UI as each category call completes
(not held until all 16 finish — see §6)
```

## 3. Data model changes

### Risk (new fields)

| Field | Type | Notes |
|---|---|---|
| `legal_status` | enum: `active_statutory \| pending_statutory \| conditional_statutory \| recognized_standard \| voluntary_best_practice` | Replaces a flawed binary "Nature: mandatory/voluntary" — the research showed at least these 4 real states exist (NIS2 is real law but not yet French-binding; Sapin II is real law but threshold-gated; APSAD/NF C 18-510 are private standards, not law). A simple "Mandatory/Voluntary" badge is *derived* from this in the UI (active/pending/conditional → "Mandatory"; recognized_standard/voluntary → "Voluntary"), not separately stored, so the two can't drift out of sync. |
| `scope` | enum: `site \| organization` | New. Group-wide obligations (Sapin II, Devoir de Vigilance, CSRD) are legally single obligations for the whole org, not one per site — duplicating them per site fragments accountability and looks wrong to a CRO reviewing the register. Org-scoped risks have `site_id = null` and surface in every site's view plus a dedicated org-wide filter. |
| `regulatory_framework_id` | nullable FK → `RegulatoryFramework` | Set only when the AI cites a curated, verified framework. |
| `regulatory_citation_note` | nullable string | Fallback for a defensible-but-uncurated citation (e.g. a live-search result, see §5) — never a fabricated article number; general framing only if uncertain. |
| `citation_confidence` | enum: `curated_verified \| ai_estimate \| none` | **Both the GRC and UX reviewers independently flagged this as the single most important trust signal.** Must be a persisted, stored field (not derived/inferred client-side), and must survive as a permanent, visible marker on the Risk detail view after import — not just during the review step. |
| `audit_frequency` | enum: `monthly \| quarterly \| semiannual \| annual \| triennial \| per_project` | |
| `audit_next_due_date` | nullable date | Computed from frequency + generation date. A bare month-of-year integer (the mockup's "M5") with no year is a bug waiting to happen once a risk survives past its first year. |
| `audit_sign_off_role` | nullable string | Who approves the audit — deliberately distinct from `internal_pilot` (segregation of duties matters for statutory items; the person who owns day-to-day risk treatment shouldn't be the same person who signs off the audit). |
| `linked_audit_id` | nullable FK → existing Audit/Inspection record | Populated once a real audit executes against this plan. Without this, `audit_frequency`/`audit_next_due_date` are decorative metadata disconnected from the app's actual audit trail — this was flagged as a real gap in review, not a nice-to-have. |
| `internal_pilot` | nullable string | Free text (per Omar's decision — AI suggests a role hint like "HSE Manager," a human fills in the real name; no FK to a real user, no notification system). |
| `ai_generation_run_id` | nullable FK → `AiRiskAnalysisRun` | Provenance — see below. Must persist through edits to the risk (an edit updates the row; it must not erase where the risk came from). |

`financial_impact_min`/`financial_impact_max` already exist — this feature just starts actually populating them with real k€ numbers instead of the old vague qualitative text.

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

### Organization-level additions

Confirmed gap during design: `OrganizationProfile` currently has `organizationName`/`logo`/`location`/`description`/`website`/`phone`/`sector`/`country` — **no headcount or revenue field at any level above a single Site.** Sapin II (≥500 employees & >€100M revenue) and Devoir de Vigilance (≥5,000 France / ≥10,000 worldwide) are evaluated against the *consolidated group*, not one site — a company with 5 sites of 150 employees each is at 750 total and should trigger Sapin II, but no existing field can ever show that.

Add to `OrganizationProfile`: `totalEmployees`, `totalRevenueEur`, `worldwideEmployees` — **manually entered/maintained by the org**, not auto-summed from tracked sites (the real consolidated figure often includes untracked subsidiaries, contractors, or non-Qiyrix sites that summing tracked Sites would miss or misrepresent). Phase 1.5's threshold check reads these fields.

**Idempotency**: Phase 1.5 runs on every "Analyze with AI" click for any site in the org, so it must **upsert**, not create — keyed on `(org_account_id, regulatory_framework_id)`. A second site's analysis re-confirming Sapin II applicability updates the existing org-scoped risk's `updatedAt`/re-validates it, never creates a duplicate.

## 4. Generation prompt design

**Regulatory grounding:** hybrid, per Omar's earlier decision. Every Phase 2 call's prompt embeds the full curated `RegulatoryFramework` reference (static-first, for prompt-cache reuse — see §7) with an explicit instruction: cite ONLY from this list, respect `legal_status` and `applicability_threshold` exactly (do not cite Sapin II unless the org's tracked totals actually clear the threshold), and use `citation_confidence: ai_estimate` or `none` rather than inventing an article number when nothing curated matches. The secondary live-search "find citation" fallback (reusing the existing Tavily-grounded pattern from Regulatory Coverage) is a **separate, on-demand, per-risk action** the user can trigger later — not part of the synchronous Analyze flow, so it never adds unpredictable latency to the main click.

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

- **Progressive results, not a blocking spinner.** Phase 2 results stream into the UI as each category call completes (SSE or short-interval polling against a server-tracked `AiRiskAnalysisRun`) — first results visible within ~10s, not a 35s dead-air wait.
- **Coverage-framed header, never a bare count.** "Analyzed 18 of 20 categories · 2 not applicable to this site" with the skipped categories and their one-line reasoning shown — converts a lower-than-mockup count into a legible, trust-building signal ("the AI reasoned about scope") instead of reading as underperformance.
- **Grouped by category**, collapsed by default, mandatory-before-voluntary sort within each. Category header shows live counts as items are actioned.
- **Citation confidence is a first-class visual badge** (curated-verified / AI-estimate / none), not buried in row text — this is the exact trust distinction that made the CEO's own mockup risky (confident-looking but sometimes-wrong citations) and it must be impossible to miss while scanning 40+ rows.
- **Scoped fast-path bulk-accept**: only mandatory + curated-verified-citation + low-financial-impact items are eligible for one-click bulk accept; anything voluntary, uncited, or high-impact requires an individual touch. This directly guards against "trust fatigue" at higher volume — the exact failure mode the UX review named as the single biggest abandonment risk.
- **Permanent provenance marker** on the Risk detail view post-import ("Sourced: AI analysis, [date] · run link"), surviving future edits to the risk.
- **Re-analysis**: dedup on `(category, regulatory_framework_id)` where a citation exists (a stable anchor, unlike free-text titles); falls back to something stronger than title-string matching for uncited risks. Never silently re-inject a previously-dismissed suggestion (existing behavior, preserved).
- **Re-run cooldown**: 10-15 minutes per site, visible in the UI ("last analyzed X ago") — caps the cost-abuse vector the engineering review flagged, cheaper and more targeted than a model-tier downgrade.

## 7. Engineering / robustness requirements

- **Partial-failure handling, explicit contract.** Each Phase 2 category call tracked independently (`pending`/`success`/`failed`); successful categories persist as they complete, not buffered until all finish. On completion, any failed categories surface explicitly ("3 of 16 categories could not be analyzed: Cyber, ATEX, Fire — Retry") with a scoped retry limited to just those categories. **Never silently drop a category** — for a risk register, an unlisted category reads as "no risk here" to an auditor, the worst possible failure mode for this specific product.
- **Prompt caching**: the curated `RegulatoryFramework` reference block must be structured static-first (byte-identical prefix across every call, every category, every site) with a cache breakpoint, so repeated Phase 2 calls actually benefit from OpenAI prompt caching rather than defeating it via naive per-call string interpolation. Fire the 16 parallel calls with a small stagger (~200-500ms) or a cheap pre-warm call, since simultaneous parallel calls can't read each other's cache — only a call that began streaming first benefits later calls.
- **Server-side output validation, regardless of schema typing.** Reuse the existing `_clamp`-style pattern (already fixed once in `risk_field_suggestion_service.py` after a real production incident) for every numeric field (`probability`, `impact`, `financial_impact_min/max`, `control_*_eff`), and extend the same discipline to the category enum (closing the `"quality"` drift found in testing) and to `regulatory_framework_id` (validate server-side against the real curated table before persisting — never trust the model's citation even if the schema is well-formed).
- **Explicit org-scoping for every parallel call's dedup query** — thread a single `resolveCallerOrgContext` result through all 16+ parallel Phase 2 calls' existing-risk lookups, not re-derived independently per call from a bare `site_id`.
- **New free-text fields need export-path hardening before shipping**: confirmed, not hypothetical — `report_pdf.ts` (Puppeteer HTML-to-PDF) and `useRiskCsvExport.ts` are real, existing Risk-data export paths. `internal_pilot` and `regulatory_citation_note` are new AI-generated free text and won't automatically inherit whatever escaping older fields have — verify/add HTML-escaping before Puppeteer rendering and CSV-formula-injection guarding (leading `=`/`+`/`-`/`@`) before shipping either field.
- **Cap `description`/`activity` field length** before they reach any prompt — the single most realistic failure mode identified in review isn't a malicious attacker, it's a long, legitimately-authored corporate description containing instructional-sounding language ("per our internal policy, X is handled separately") that gets duplicated into all 16+ parallel calls at once and could bias the whole run in a way no single reviewer would catch scanning one category at a time.
- **Live-search citation fallback** must reuse the exact `prompt_data_block`/`prompt_user_input` wrapping the existing `regulatory_coverage_service.py` already applies correctly to fetched search-result content, not a new, unwrapped concatenation.

## 8. Explicitly out of scope for this design

- Real assignable risk owners (linked to actual org users, with notifications) — Omar's call: free text only, matching the mockup.
- A general org-level risk register *page/view* beyond a scope filter on the existing Risk Register — the `scope: organization` field and its display are in scope; a dedicated new page is not.
- Non-French/EU jurisdictions — explicitly France/EU-focused per Omar's answer; a global version is a distinct future project, not a phase of this one.
