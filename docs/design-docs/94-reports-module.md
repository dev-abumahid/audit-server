# Design Doc: aexa-frontend#94 — Reports page is fully simulated

Status: draft for review
Scope: design-only, no code changes made
Multi-repo: aexa-frontend, aexa-server, (optionally) aexa-ai

## Problem Statement

`aexa-frontend/src/dashboard/organization/reports/ReportsPage.tsx` renders a Reports feature that looks real but does nothing real:

- `DUMMY_REPORTS` (lines 21-42) seeds the list with two hardcoded fake reports.
- `handleGenerate()` (lines 49-73) awaits a `setTimeout(2200)`, fabricates a report object with a random page count, pushes it into local state, and `alert()`s a fake success message. No data is read, no AI is called, nothing is persisted.
- `handleDownloadPDF` / `handlePreviewPDF` (lines 75-83) are `alert()` stubs with `// In a real app this would...` comments — no PDF is ever produced.

The dropdown already lists 5 report types (`Board Report`, `Monthly Executive Committee Report`, `Internal Audit Assurance Opinion`, `Monte Carlo Stress Test Report`, `Compliance Status Report`) — this is copy-pasted from Fullbloom's French-language equivalent list, not derived from anything aexa-server can currently produce.

Three things are missing before this can be real: (1) a PDF-generation mechanism, (2) a `Report` persistence model server-side, (3) a decision on whether generation goes through aexa-ai the way risk analysis (#24) does.

## Research Findings

### 1. Fullbloom precedent (`YouYouLux/full-bloom-app`, `main`, private repo — read via `gh api`)

Fullbloom's `src/features/reports/pages/ReportsPage.tsx` is a materially more complete version of the same UI shell Qiyrix already has (same layout, same card grid, same button icons — confirms Qiyrix's shell was ported from this file before the real logic was stripped out).

**Data flow on Generate** (lines 37-91):
1. Fetches `risks`, `compliance obligations`, `audit engagements`, `KRIs` via existing service functions, plus `sites` and `audit_findings` via direct Supabase queries — all scoped to `currentOrg.id`.
2. Filters risks to `status !== 'pending' && status !== 'dismissed'`.
3. Calls a single Supabase Edge Function, `ai-report`, passing all six datasets plus `organizationData` (name, sector, EBITDA, country, revenue, employee count) and the selected `reportType` string.
4. The edge function (`supabase/functions/ai-report/index.ts`) calls an LLM (`callAIJSON`, model `openai/gpt-5`, `temperature: 0.15`, `max_tokens: 65536`) with a system prompt (`src/prompts/report-system.ts`) that is extremely explicit about **not inventing data**: "Tu dois EXCLUSIVEMENT utiliser les données fournies... RIEN inventer" repeated per data category. The LLM's job is presentation/synthesis (professional wording, scoring rollups, trend arrows, financial scenario narrative) over data it's handed, not fabrication.
5. The LLM returns one large structured JSON object (not prose, not a PDF) — schema includes `title`, `subtitle`, `reference`, `classification`, `signatories`, `summary`, `riskAppetite[]`, `topRisks[]`, `financialAnalysis{scenarios[], insuranceCoverage[]}`, `kriDashboard[]`, `complianceRegister[]`, `auditPlan[]`, `auditFindings[]`, `actionPlan[]`, `jointDeclaration{riskProfile, financialImpact, internalControl}`, `keyMetrics{}`, `outlook`, `pages`.
6. This JSON is persisted as-is via `createReport({ ..., content: finalResult, status: 'draft', ... })` — **the JSON is the source of truth that gets stored, not a PDF binary.**

**PDF generation is entirely client-side and on-demand** (`src/shared/services/pdfGenerator.ts`, 474 lines): `generateBoardPDF(report)` takes the stored `report.content` JSON and builds a PDF in-browser using `jsPDF` + `jspdf-autotable` — cover page, per-section tables (risk appetite, top risks, financial scenarios, KRI dashboard, compliance register, audit plan, findings, action plan, joint declaration/signature block), headers/footers with page numbers and a "CONFIDENTIEL" watermark line. Both `handleDownloadPDF` (calls `doc.save(filename)`) and `handlePreviewPDF` (calls `doc.output('bloburl')` and opens it in a new tab) **regenerate the PDF fresh from the stored JSON every time** — no PDF binary is ever stored or fetched from a server.

Important consequence: Fullbloom's "report" is really a stored, structured JSON snapshot; the PDF is a pure rendering of it, computed wherever it's needed. There is no `report_snapshots`-style blob storage in Fullbloom at all.

The `REPORT_TYPES` list in Fullbloom's UI is cosmetic — the prompt and returned JSON schema barely vary by type (`reportType` is passed into the prompt as a label the LLM should title/frame around, but the requested JSON shape is fixed across all 5 types). Fullbloom did not actually build 5 structurally distinct report generators; it built one generic "consolidated risk & audit" JSON schema and lets a dropdown value change the framing.

### 2. CDC spec precedent (`/tmp/cdc-spec.txt`)

The CDC describes a heavier, server-side architecture that Fullbloom did not actually build (the CDC is aspirational/target-state, not a description of what exists):

- **§2.1 microservices table** (line 141-146): a dedicated `report-generator` service — "PDF CA · CODIR · IIA · CSRD · Export Excel", stack **Puppeteer + ReportLab** (Node.js + Python), storage **S3**, scaling **async queue**. This implies HTML→PDF via headless Chrome for styled board/CODIR decks, and a Python PDF library (ReportLab) for the more tabular/programmatic outputs (IIA audit reports, CSRD, Excel export).
- **`report_snapshots` table** (line 509-511): `id, org_id, type ENUM, generated_at, generated_by, file_url, parameters JSONB, version INTEGER` — "Rapports PDF générés — stockage S3 + URL signée." This is the opposite of Fullbloom's approach: an immutable stored PDF blob referenced by a signed URL, versioned, not regenerated from live data after the fact.
- **API**: `POST /api/v1/reports/generate` (line 1556-1560), scope `reports:generate`, body `{ type: board|codir|audit|csrd, parameters }`, explicitly **async** (matches the "Async queue" scaling note on report-generator).
- **§7.5 Module Audit Interne** (line 1319-1344), the "Rapport draft IA" row (line 1339-1341): "Claude API génère draft rapport Word complet (Executive summary + findings détaillés + opinion d'assurance IIA). **Révision humaine obligatoire avant publication.**" — this is a distinct, higher-stakes flow from the general board/CODIR snapshot: output format is Word DOCX (not PDF), content is the IIA-structured findings + formal assurance opinion pulled from `audit_engagements`/`findings`, and the spec is explicit that nothing publishes without a human reviewing it first (`report_generation async` workflow, `finding_closure workflow` referenced separately). §7.7 similarly describes a "Déclaration de conformité CA" as a signable Word document with an e-signature workflow.

Net: the CDC's target architecture separates "informational board/CODIR PDF" (can plausibly auto-publish) from "the IIA audit opinion / compliance declaration" (must be human-reviewed and is a signable document, not just a report) — the human-review gate in the CDC is specific to the CAE/compliance sign-off documents, not stated as universal.

### 3. aexa-ai's existing AI-generation pattern (precedent from #24, risk analysis)

`aexa-ai/app/services/risk_analysis_service.py` + `aexa-ai/app/api/v1/endpoints/risk_analysis.py`:
- FastAPI endpoint `POST /risk_analysis`, rate-limited via `@limiter.limit(settings.rate_limits.expensive)`.
- Calls **OpenAI** (`app.clients.openai_async_client`, not Anthropic despite the CDC naming Claude throughout) with `response_format={"type": "json_object"}` and a schema described entirely in the user prompt (few-shot example embedded in-line), not via a JSON-schema tool call.
- Validates/normalizes the raw JSON server-side (`_normalize_risks`) before returning — drops any risk item missing required fields or with an out-of-range score, rather than trusting the LLM's output shape blindly.
- Returns synchronously; the caller (aexa-server's `ai.service.ts` pattern, see below) is a simple `fetch()` + `await response.json()`.

`aexa-server/src/app/modules/ai/ai.service.ts` shows the calling convention aexa-server already uses for aexa-ai: every outbound call carries `X-Internal-Secret: configs.ai_internal_secret` (exported as `AI_INTERNAL_SECRET_HEADER`, enforced by aexa-ai as a global auth dependency), org context is resolved via `resolveCallerOrgContext(user.accountId)` + `assertCanWriteOrgResource(ctx)` before the call, and the AI response is validated with a Zod schema (`template_validations...parseAsync`) before being persisted via Prisma. This is the established multi-repo call pattern a Reports feature should reuse rather than reinvent.

### 4. External research — PDF generation architectures

Compared three real approaches for Node.js SaaS reporting:

- **Headless-Chrome / Puppeteer (HTML→PDF)**: renders arbitrary CSS-styled HTML to pixel-accurate PDF — best fit for a board-deck-style layout with real typography, tables, charts. Cost is operational: Puppeteer is "built for browser automation, not PDF generation," and running it in production means provisioning enough RAM for Chromium, managing the browser process lifecycle, and (per current guidance) using a minimized package to fit Lambda size limits if deployed serverless; at scale you need browser pools, health checks, and crash auto-restart. [Nutrient: Top JS PDF libraries 2026](https://www.nutrient.io/blog/top-js-pdf-libraries/), [Lead With Skills: Puppeteer vs PDFKit](https://www.leadwithskills.com/blogs/pdf-generation-nodejs-puppeteer-pdfkit)
- **Native PDF library (pdf-lib / PDFKit / jsPDF)**: programmatic, low-level PDF construction — no browser process, low resource usage, moderate implementation effort (you lay out every section by hand, as Fullbloom's `pdfGenerator.ts` does with `jsPDF` + `jspdf-autotable`). Best fit for data-heavy tabular reports where layout is mostly tables and text blocks rather than rich free-form design. Lighter and faster than Puppeteer, but you lose CSS-level styling convenience. [OneUptime: PDF generation in Node.js](https://oneuptime.com/blog/post/2026-01-22-nodejs-pdf-generation/view)
- **Hosted PDF-generation API** (e.g. PDFBolt-class services): same Chromium rendering as Puppeteer, but the vendor manages Chromium instances, scaling, and updates; typically offers sync/async endpoints, webhooks, and direct upload to your own S3 bucket. Removes the ops burden entirely at the cost of a per-document vendor bill and an external dependency in the generation path. [PDFBolt vs Puppeteer comparison](https://pdfbolt.com/compare/puppeteer)

On **report content structure**, IIA guidance and board-reporting practice converge on a fairly fixed shape:
- Final engagement communications must include objectives, scope, results, conclusions, and (where applicable) an overall opinion — Standard 2410.A1 requires the auditors' opinion be included when one is expressed, and it "must take into account the expectations of senior management, the board, and other stakeholders" and be "supported by sufficient, reliable, relevant, and useful information." [IIA: Audit Reports — Communicating Assurance Engagement Results](https://www.theiia.org/globalassets/documents/content/articles/guidance/practice-guides/audit-reports-communicating-assurance-engagement-results/pg-audit-reports.pdf)
- The executive summary should "briefly summarize the audit objectives, scope, and key findings, highlighting the most significant issues and recommended actions." [IIA Audit Report Writing Toolkit](https://www.theiia.org/globalassets/site/auditing-report-writing-toolkit.pdf)
- Findings should follow the "Five Cs": Criteria, Condition, Cause, Consequence, Corrective Action — this maps almost exactly onto the CDC's `findings` table shape (`criteria, condition, effect, root_cause, recommendation`, line 501) and confirms that schema is standards-aligned, not invented.
- Standard 2440 (Disseminating Results) puts dissemination decisions in the CAE's hands — results go to those with authority to act on them, which is the practice-guide basis for a human-review-before-publish gate on anything carrying an audit opinion. [IIA Standards](https://www.theiia.org/en/standards/what-are-the-standards/mandatory-guidance/standards/)

### 5. Existing storage conventions in this codebase

- `aexa-server/src/app/modules/action/action.service.ts:6` imports `uploadCloud from '../../utils/cloudinary.js'` — Cloudinary is the **proven, in-use** upload path today (used for action attachments).
- `aexa-server/src/app/configs/index.ts:21-25` already declares `aws: { bucket, region, access_key_id, secret_access_key }` — S3 config plumbing exists but **nothing in `src/app` currently uses it** (no `find -iname "*s3*"` hits under `src`). It's provisioned-but-unused, not a working pattern to copy from.
- No BullMQ queue currently exists for anything resembling report generation — `aexa-server/src/app/queues/` only has email workers (OTP, org-invite, reset-password, external-verification). Async job infra for a slow AI+PDF pipeline would be new, not reused.
- **No `Report` Prisma model exists yet** (`grep -il report prisma/schema/*.prisma` → no hits) and **no audit/compliance backend exists yet** (`grep -il "audit\|finding"` only hits an unrelated field name; `modules/` has no `audit` or `compliance` directory). Risk, KRI, Site, and Action are the only report-relevant domains actually queryable server-side today.

## Alternatives Considered

### A. PDF-generation mechanism

| Option | Complexity | Cost | Output quality | Fit here |
|---|---|---|---|---|
| **Client-side jsPDF/pdf-lib (Fullbloom's approach)** | Low — one rendering function, no server infra | $0 infra | Good for tabular sections, more work to get a polished cover-page/typography feel; already proven in Fullbloom's 474-line `pdfGenerator.ts` | Fast to ship, zero new backend infra, but the PDF is never a stored artifact — see Data Model discussion below |
| **Server-side Puppeteer (HTML→PDF)** | Medium-high — needs a render service/queue, Chromium in the container, memory headroom | Server compute, no per-doc vendor fee | Best — full CSS control, matches "board deck" polish bar | Matches CDC's target architecture; heavier ops lift, first server-rendered artifact in aexa-server |
| **Native Python lib (ReportLab) via aexa-ai** | Medium | Server compute | Good for tabular/data-heavy docs, more manual layout work than HTML | Only relevant if PDF generation is pushed into aexa-ai (Python) rather than aexa-server (Node) |
| **Hosted PDF API** | Low (integration only) | Per-document vendor cost, ongoing | Same rendering quality as Puppeteer (usually Chromium-backed) | Fastest to ship a server-rendered PDF without owning Chromium ops, but adds a paid vendor + external dependency for a CTO-sensitive "sovereignty of client risk data" product |

### B. Report-type scope for MVP

1. **Single generic report type** ("Consolidated Risk Report") with one JSON schema and one prompt, dropdown reduced to what's real. Matches what Fullbloom's prompt actually does under the hood (the 5-type dropdown is mostly cosmetic there too) and matches what aexa-server's real data supports today (Risk, KRI, Site — no audit/compliance backend exists).
2. **All 5 Fullbloom-parity types now** (Board, Monthly Exec, IIA Assurance Opinion, Monte Carlo Stress Test, Compliance Status). Would require standing up audit engagement/finding models and a compliance-obligation model server-side first (neither exists), plus a Monte Carlo simulation engine (CDC §4/§7.3 describes this as its own `risk-core` capability, also not built) — this is several tickets' worth of prerequisite work disguised as one.
3. **Two types now** — Board Report (general risk/KRI/site rollup, no audit dependency) and Compliance Status Report deferred/dropped until a compliance model exists; IIA Assurance Opinion and Monte Carlo deferred until their respective backends (audit engine, Monte Carlo engine) land.

## Recommended Approach

**PDF mechanism: server-side Puppeteer (HTML→PDF) in a new `report-generator`-style path, not client-side jsPDF.** Rationale: this is a GRC product whose reports get minuted at board meetings and (for the audit-opinion case) formally reviewed and signed — that requires an **immutable artifact**, not something silently re-rendered from possibly-since-edited live data every time someone clicks "download" months later (Fullbloom's approach has this correctness gap: if a risk's title or score is edited after a board report ships, re-opening "Download" on that old report will show the edited data, not what the board actually saw). Puppeteer over pdf-lib because the layout bar here (cover page, branded header/footer, styled tables) is closer to what HTML/CSS is good at and what Fullbloom's own hand-rolled `jsPDF` table code is straining to approximate. Puppeteer over a hosted API for MVP because per-document vendor billing and an external rendering dependency aren't justified yet at current scale — revisit the hosted-API option if Puppeteer's ops overhead (Chromium in containers, memory, crash handling) becomes a real operational burden.

**Report-type scope: start with one type — a general "Board / Risk Committee Report."** Build the JSON content schema generically (organization summary, top risks, KRI dashboard, action items) sourced from Risk/KRI/Site/Action, the only domains that actually exist server-side today. Do not build the IIA Assurance Opinion or Compliance Status report types in this pass — they depend on audit-engagement/finding and compliance-obligation models that don't exist in aexa-server yet (confirmed via schema grep), and building a truncated/fake version of an IIA opinion report would be worse than not having the feature, given this ticket exists specifically because the current page fakes things. Keep the dropdown but mark the other 4 types "Coming soon" (disabled) rather than removing them, since the UI copy and Fullbloom precedent both already anticipate them — this keeps the information architecture stable for when audit/compliance backends land.

**AI call: reuse the aexa-ai pattern from #24, don't invent a new one.** Add a `POST /report/generate` (or similar) endpoint to aexa-ai following `risk_analysis.py`'s shape — FastAPI, rate-limited, OpenAI JSON-mode call, Pydantic-validated response — with a system prompt carrying the same "use only the data you're given, do not invent" constraint Fullbloom's prompt uses (this constraint is doing real work: it's what keeps an LLM from hallucinating risks/findings that don't exist in a document a board will read). aexa-server calls it the same way `ai.service.ts` calls the template-generation endpoint today: `X-Internal-Secret` header, `resolveCallerOrgContext` + org-write assertion before the call, Zod-validate the response before persisting. Whether the LLM should be OpenAI (current aexa-ai convention) or Anthropic Claude (what the CDC spec assumes throughout) is a decision Omar should make explicitly rather than defaulting silently — flagged in Open Questions.

**Human review before publish: yes, and make it universal, not type-specific.** The CDC only mandates this for the IIA opinion/compliance-declaration flows, but nothing in real board-reporting practice ships an AI first draft straight to a board unreviewed, and it costs nothing to gate every report the same way: `status: draft → published` is a separate, explicit action a human takes (e.g. a "Publish" button distinct from "Generate"), never automatic. This also sidesteps a harder question — differentiating review requirements per report type — until there's more than one type to differentiate.

**Async job handling:** report generation (data fetch + AI call + Puppeteer render) will comfortably exceed a synchronous request timeout for anything beyond a handful of risks. Use the existing BullMQ infra pattern (`aexa-server/src/app/queues/`) — a new `report` queue and worker, mirroring the existing email worker structure — rather than inventing a different async mechanism. Frontend polls report `status` (`generating → ready → failed`) rather than blocking on the initial `POST`.

## Data Model

New Prisma model in `aexa-server/prisma/schema/` (new file `report.prisma`, following the one-model-family-per-file convention):

```prisma
model Report {
  id             String       @id @default(uuid())
  org_account_id String
  account        Account      @relation(fields: [org_account_id], references: [id])

  type           ReportType   // BOARD only for MVP; enum leaves room for future types
  title          String
  reference      String?      // e.g. "BOARD-2026-Q3" — human-facing citation id
  status         ReportStatus @default(GENERATING)

  // Structured content returned by aexa-ai — the source of truth for what
  // was reviewed/published, independent of the rendered PDF. Kept even
  // though we render server-side, so a future re-render or template change
  // doesn't require re-calling the AI.
  content        Json?

  // Immutable rendered artifact — set once generation succeeds. Cloudinary
  // secure_url (resource_type: "raw"), reusing the proven upload pattern
  // from action.service.ts rather than the unused S3 config.
  file_url       String?
  pages          Int?

  parameters     Json?        // inputs used to generate: date range, site filter, etc.
  version        Int          @default(1)

  generated_by   String       // Account id of the human who clicked Generate
  reviewed_by    String?      // Account id of the human who clicked Publish
  reviewed_at    DateTime?

  ai_generated   Boolean      @default(true)
  error_message  String?      // populated if status = FAILED

  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  @@index([org_account_id])
}

enum ReportType {
  BOARD
  // COMPLIANCE, AUDIT_OPINION, MONTE_CARLO, EXEC_COMMITTEE — add when their
  // backing data models exist
}

enum ReportStatus {
  GENERATING
  READY        // AI + PDF succeeded, awaiting human review
  PUBLISHED    // reviewed and published — file_url is now considered final/citable
  FAILED
}
```

Org-scoping follows the `orgAccountId`-family convention (`action`, `recommendation`, `template`, `inspection`, `note`) per aexa-server's CLAUDE.md field-naming table, using `org_account_id` to match Risk/KRI/Site's snake_case convention since Report pulls from those domains — **confirm which convention wins here before implementing**, it's the one config-level ambiguity CLAUDE.md itself calls out as inconsistent.

## API Endpoints

**aexa-server**
| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/report/generate` | Enqueue generation: fetch org's Risk/KRI/Site/Action data, call aexa-ai, render PDF async, create `Report` row with `status: GENERATING` | `auth('ORGANIZATION')` |
| `GET` | `/report` | List org's reports (for the grid) | `auth('ORGANIZATION')` |
| `GET` | `/report/:id` | Single report detail/status poll | `auth('ORGANIZATION')` |
| `GET` | `/report/:id/download` | Redirect/proxy to `file_url` (or return signed Cloudinary URL) | `auth('ORGANIZATION')` |
| `PATCH` | `/report/:id/publish` | Human-review gate: `status: READY → PUBLISHED`, sets `reviewed_by`/`reviewed_at` | `auth('ORGANIZATION')`, org-admin-only per `assertIsOrgAdmin` pattern already used in `action.service.ts` |

**aexa-ai**
| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/report_content` | Given org data (risks, KRIs, sites, actions, org profile) + report type, return structured JSON content (mirrors `/risk_analysis`'s shape) | `X-Internal-Secret` header, aexa-server-only |

PDF rendering (Puppeteer) can live in aexa-server's new `report` queue worker (renders the returned JSON into HTML via a template, then to PDF) — no new aexa-ai endpoint needed for that step, keeping aexa-ai's role to "AI content generation only," consistent with its existing scope.

## UI/Workflow Implications

Mapping `ReportsPage.tsx`'s existing shell to the real flow:

- `handleGenerate()`: replace the `setTimeout` fake with `POST /report/generate`, then start polling `GET /report/:id` (or list refetch) until `status` leaves `GENERATING`. Replace the success `alert()` with a toast (Fullbloom already does this with `useToast` — good precedent to port) and keep the button disabled/spinning for the whole async window, not just 2200ms.
- Report cards: add a status badge, `PUBLISHED` reads the current `Draft`/`Published` treatment already coded (`report.status === "published"` styling at lines 173-181 can mostly be reused, just fed by the real enum), `GENERATING`/`FAILED` need new visual states (the shell has none today).
- `handleDownloadPDF`: replace `alert()` with `window.open(file_url)` or a fetch-and-save against `GET /report/:id/download`. Only enabled once `status !== GENERATING`.
- `handlePreviewPDF`: since the PDF is server-rendered and stored (unlike Fullbloom's client-regenerate approach), preview is just opening `file_url` in an iframe/new tab — no client-side PDF library needed on the frontend at all.
- New: a "Publish" action on `READY` reports, gated to org-admins, wired to `PATCH /report/:id/publish` — this is the human-review step and doesn't exist in the current shell or in Fullbloom's UI (Fullbloom has a `status: 'draft'` field but no visible publish action was found in the read file — worth flagging that Fullbloom's own review gate may be incomplete, don't assume its absence there means it's unnecessary here).
- Report-type dropdown: keep all 5 options visually (matches existing IA and Fullbloom precedent) but disable the 4 not yet backed by real data, with a tooltip/label indicating why (e.g. "Requires audit module — coming soon").

## Open Questions for Omar

1. **OpenAI vs Claude for report content generation.** aexa-ai's existing pattern (#24) uses OpenAI; the CDC spec assumes Anthropic Claude throughout. Report content is higher-stakes than risk-analysis suggestions (it's board-facing), which may or may not change your calculus on provider choice. Confirm which you want, or whether this is a case for keeping OpenAI now and revisiting model choice later.
2. **Cloudinary `resource_type: raw` for PDF storage vs finally wiring the already-configured-but-unused S3 keys.** Cloudinary is proven in this codebase but is primarily an image CDN; S3 is the "correct" tool and the config already exists, just unused. Recommend Cloudinary for MVP (less new surface area) but flag this as a likely future migration if PDF volume/retention requirements grow — want your call on which to build against now.
3. **Human-review gate: universal or type-specific?** I'm recommending universal (every report needs an explicit Publish click) for simplicity and because it matches real board-reporting practice, but if you want AI-generated Board Reports to auto-publish (lower stakes than a signed audit opinion) that's a one-line change to the state machine — your call.
4. **Org-scoping field name for `Report`** — `orgAccountId` (camelCase, matches action/recommendation/template) or `org_account_id` (snake_case, matches risk/kri/site, the domains Report actually reads from)? CLAUDE.md flags this as an existing inconsistency rather than a settled convention.
5. **BullMQ vs synchronous-with-timeout for v1.** Given current data volumes (single-org risk counts are likely small), is a full async queue worth the added infra now, or is a longer synchronous timeout (with a client-side "this may take up to a minute" message) acceptable to ship faster, with the queue as a fast-follow once report generation is proven to actually need it?

## Effort Estimate

**L (multi-repo, as flagged in the issue).** Breakdown:
- aexa-server: new `Report` model + migration, new `report` module (route/controller/service/validation) with org-scoping, new BullMQ queue + worker wiring Puppeteer, Cloudinary raw-upload integration, publish/review endpoint — this is comparable in size to standing up any other full CRUD module in this codebase, plus the queue/render infra which is genuinely new (no async job precedent to copy beyond the email workers' basic shape).
- aexa-ai: new `/report_content` endpoint, prompt design/tuning (the "don't invent data" constraint needs real testing against Qiyrix's actual Risk/KRI shapes, not just copied from Fullbloom's French prompt), Pydantic schema.
- aexa-frontend: polling/async state handling (new — current page has none), status badges for GENERATING/FAILED, publish action + admin gating, download/preview against a real URL instead of alerts.
- Not included in this estimate: audit-opinion and compliance-status report types (explicitly deferred pending their own backend modules — each of those would be its own comparable-sized ticket once the underlying audit/compliance data models exist).
