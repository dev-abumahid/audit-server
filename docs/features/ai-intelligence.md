# AI & threat intelligence

This is the aexa-server-side view (the two modules that call out to the aexa-ai service). For
what aexa-ai itself actually does with each call — model choice, RAG pipeline, rate limiting,
prompt-injection handling — see [ai-service.md](ai-service.md).

## `ai` module — proxy layer to the aexa-ai service

No interesting business state of its own (the `Ai` model is essentially unused) — a thin,
stateless proxy. Generates templates from a prompt/PDF/risk, analyzes site risks (returns
candidates for manual review/import, never auto-creates), generates inspection recommendations,
and manages Pinecone-backed knowledge-base document upload/status/delete.

**Security-relevant plumbing:**
- `buildAiHeaders(orgAccountId)` attaches both the shared `X-Internal-Secret` and a freshly
  minted, short-lived signed org-identity token (`org_token.ts`), so aexa-ai's rate limiter keys
  on a real authenticated org rather than a self-reported header.
- `wrapAiServiceError` ensures raw upstream/Zod/Prisma error text never reaches the client —
  only `AppError`s crafted in this file are rethrown as-is.
- All outbound calls go through `fetchWithTimeout` with tiered timeouts: LLM calls 45s, PDF/OCR
  90s, lightweight lookups 15s. **This now covers every module that calls aexa-ai**, not just
  this one — the note, intelligence, inspection, risk-correlation and onboarding paths each had
  a bare `fetch` with no timeout, so a hung aexa-ai response pinned an aexa-server request open
  indefinitely (#275). Any new outbound call to aexa-ai belongs on this helper.
- **aexa-ai responses are validated, not spread.** `note.service.ts` field-picks its response
  through a Zod schema before the Prisma create, instead of spreading the raw payload — an
  upstream shape change, or a field aexa-ai simply shouldn't be setting, otherwise wrote straight
  into the row. A validation failure is handled like a JSON-parse failure, cleanup of the
  uploaded file included (#276).

## `intelligence` module — threat intelligence

`IntelligenceItem` (RSS-scraped threat articles) plus point-in-time org-level AI analyses
(`IntelligenceRun`, one of `PREDICT | MITIGATIONS | RCSA | RESILIENCE_SCAN`).

All six endpoints (`/scrape`, `/analyze`, `/predict`, `/mitigations`, `/rcsa`,
`/resilience-scan`) sit behind `intelligenceLimiter`, sized alongside the other expensive
fan-out routes (`onboardingLimiter`, `reportGenerateLimiter`); `/scrape` additionally carries a
`routeTimeout`, since its fan-out across external RSS sources is the one call that can hang on
something neither service controls (#298).

- **Scrape**: dedupes both in-batch and against existing persisted rows (by `link`, else
  `source`+`title` case-insensitively). Dedup alone isn't enough under concurrency — two scrapes
  running at once each checked for existing rows before either had written, and both inserted.
  The create pass therefore runs inside a transaction holding a Postgres advisory lock keyed on
  the org (`pg_advisory_xact_lock`, auto-released at commit), with an explicit transaction
  timeout so a scrape waiting behind an in-flight one for the same org fails cleanly rather than
  inheriting Prisma's default (#298, follow-up #300).
- **List filtering is server-side.** `searchTerm` (title/description, case-insensitive) and
  `severity` are query params, not client-side array filters over the current page — filtering
  one page at a time produced misleading counts and pages that looked empty while later pages
  held matches (#293 server, #253 frontend).
- **Analyze**: dedupes by title before calling aexa-ai (its response only keys back by
  `original_title`, so two different sources with an identical headline would otherwise get
  cross-attributed), then fans the one analysis back out to every item sharing that title.
- **Promotion to Risk** (`create_risk_from_item_into_db`) — explicit, user-triggered, one-shot:
  `created_risk_id` is claimed via a conditional `updateMany` that closes the TOCTOU window, so
  at most one Risk is ever linked per item. Severity label maps to a numeric score
  (critical=90/high=70/medium=50/low=30) for both inherent and residual (residual==inherent at
  creation, since no controls have been assessed yet). Falls back to the org's earliest Site if
  none specified. `probability` is derived from the item's `relevance_score` and **clamped** on
  the way in — see [risk.md](risk.md) for why every AI-derived producer clamps. (Framed as an
  explicit improvement over the Fullbloom reference's equivalent flow.) On the client, promotion
  invalidates `RISK` so the register reflects the new risk immediately (#261).

## Frontend wiring (aexa-frontend)

- **`ai` module**: template generation (topic/PDF/risk), site risk analysis, and recommendation
  generation/editing are all fully wired. Knowledge-base doc management (upload/status/list/
  delete) is wired under org settings.
- **`intelligence` module**: fully wired, including all four AI run types (`PREDICT`/
  `MITIGATIONS`/`RCSA`/`RESILIENCE_SCAN`), each with its own typed result shape, plus item
  scraping, severity filtering, and promotion to Risk (gated to ADMIN/LEAD_AUDITOR).
