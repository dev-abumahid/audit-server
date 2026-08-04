# aexa-ai (the separate AI microservice)

This document covers **aexa-ai itself** — the standalone service aexa-server's `ai` and
`intelligence` modules call out to (see [ai-intelligence.md](ai-intelligence.md) for the
aexa-server-side view). Repo: `Qiyrix/aexa-ai`. Python/FastAPI, thin router→service split
(`app/api/v1/endpoints/*.py` → `app/services/*.py`), Pydantic schemas, all model/rate-limit/RAG
config centralized in `config/config.yaml`.

Its README is stale (wrong path prefix, wrong/missing endpoint names) — treat the code,
`config/config.yaml`, and tests as the only source of truth.

## Auth — two layers, only one is a real gate

1. **`X-Internal-Secret`** — a single shared secret, required on **every** route via an
   app-wide FastAPI dependency (`Depends(verify_internal_secret)` at app construction, not
   opt-in per router). Compared with `hmac.compare_digest` (constant-time), on **bytes**: both
   sides are encoded before comparison because `compare_digest` raises `TypeError` on a `str`
   containing non-ASCII, and Starlette decodes header values as latin-1 — so a non-ASCII header
   value turned what should be a clean 401 into an unhandled 500 plus a logged stack trace per
   request (#166).

   **"Every route" means every `APIRoute` — which is not every path.** FastAPI's app-level
   `dependencies=` does not apply to the framework's own auto-registered documentation routes,
   so `/openapi.json`, `/docs` and `/redoc` were reachable with no auth at all, publishing the
   full API surface to anyone who could reach the service. They're now disabled outright when
   `ENV=production` (`docs_url`/`redoc_url`/`openapi_url` set to `None`), wired through both
   docker-compose and the Dockerfile default (#164). Worth remembering before adding anything
   else that FastAPI registers on the app rather than on a router.

2. **`X-Org-Token`** — a signed JWT (`{org_account_id, exp}`, HS256, **signed with the same
   shared secret** as `X-Internal-Secret` — deliberately, so no second secret needs
   provisioning/rotation). Verification failures return `None` silently rather than rejecting
   the request. **This token gates nothing** — it exists purely so the rate limiter can key on a
   real org instead of a self-reported one (see below). A caller can omit it and still hit every
   endpoint with just the shared secret.

## Endpoints, by capability

| Capability                                      | Route(s)                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Template generation (topic / PDF / risk)        | `POST /template_from_topic`, `POST /template_from_pdf`, `POST /tamplate_from_risk` _(sic, real route)_                                           |
| Site risk analysis                              | `POST /risk_analysis`                                                                                                                            |
| Inspection recommendations (RAG)                | `POST /generate_recommendations_from_answer`                                                                                                     |
| Note/survey-answer extraction                   | `POST /extract-survey-answers`                                                                                                                   |
| Root-cause bucketing                            | `POST /risk/rootcause-bucketing`                                                                                                                 |
| Threat intelligence (5 actions)                 | `POST /intelligence/{analyze,predict,mitigations,rcsa,resilience-scan}`                                                                          |
| KRI baseline (onboarding)                       | `POST /kri-baseline`                                                                                                                             |
| Company-profile / sites (onboarding "Identify") | `POST /company-profile`, `POST /company-sites`                                                                                                   |
| Knowledge-base / Pinecone pipeline              | `POST /upload-pdf-to-pinecone`, `GET /upload-status/{file_id}`, `DELETE /delete-vectors-by-filename`                                             |
| OCR (standalone)                                | `POST /extract-text`                                                                                                                             |
| Board report content                            | `POST /report_content` — **not previously documented from the aexa-server side; confirm which module (Reports/Governance) actually calls this.** |

## Mechanism notes worth knowing

- **Template/recommendation/analysis endpoints are single or multi-stage `gpt-4o`/`gpt-4o-mini`
  JSON-mode calls**, not fine-tuned models. `/generate_recommendations_from_answer` is the most
  elaborate: an 8-stage RAG pipeline (positivity pre-filter → embed → Pinecone retrieve →
  LLM rerank → relevance pre-filter (regex heuristics + LLM check) → ideal-answer generation →
  actual recommendation → overall-summary synthesis), each stage concurrency-bounded by a shared
  semaphore (size 5).
- **The rerank stage fails toward keeping chunks, not dropping them.** Scores are zipped onto
  chunks under an explicit length check rather than a bare `zip()`, which silently stops at the
  shorter sequence — a short score list left the tail of the chunks unscored and misaligned the
  rest (#125). And when score _parsing_ fails, the documented behavior is "fall back to the
  original order": that fallback now stamps each chunk with the minimum passing score, because
  chunks carrying no score at all defaulted to `0` against a positive threshold downstream, which
  discarded every retrieved chunk instead of keeping them unranked (#149). A genuinely unexpected
  failure still raises `RerankError` rather than quietly returning an unranked result.
- **PDF section splitting binds by position, not by substring match.** Sections are resolved in a
  single position-first pass, so a heading whose text also appears earlier in the body (or as a
  substring of another heading) can't capture the wrong span of the document (#126).
- **`/template_from_pdf`'s own code comment claims it uses "Pinecone knowledge base" — it does
  not.** `generate_survey_from_text` never queries Pinecone; sections/questions come purely from
  OCR'd text. Don't assume this endpoint grounds generation against an org's uploaded documents.
- **KRI baseline is NOT an LLM call** — a deterministic keyword→template lookup table (10
  category groups, curated starter KRIs), by explicit design: "a fabricated numeric
  alert_threshold is worse than a fabricated prose description."
- **No LLM response caching anywhere.** The only "caching" is a Pinecone-client-handle memo and
  an already-uploaded-file short-circuit (SHA-256 `file_id` fetch check) in the upload pipeline.
- **Prompt-injection defense is uniform and simple**: every untrusted value (scraped RSS text,
  uploaded-PDF samples, org/risk records, retrieved Pinecone chunks) is HTML-escaped and wrapped
  in literal `<user_input>` tags, plus a fixed instruction sentence appended to every system
  prompt telling the model to treat tagged content as data, not instructions. This is XML-tag
  delimiting + an instruction — no content classifier, no output-side check that the model
  actually complied.
- **Retries**: one shared helper (`llm_retry.py`) retries only `openai.RateLimitError`,
  exponential backoff, max 3 attempts; any other exception raises immediately. All OpenAI calls
  have a hard 60s client timeout. A `max_retries` below 1 raises `ValueError` at the call rather
  than being tolerated — the retry loops are written as "attempt up to N times", so a
  misconfigured `0` meant zero attempts and a silent `None`/sentinel return that read downstream
  as "the model produced nothing" instead of "this service is misconfigured" (#144, #146).

## Parsing LLM output — two shared helpers, and why they're shared

Both of these started as per-service copies that drifted, and each drift was a real bug. New
services should use the shared helper rather than re-deriving the logic.

- **`strip_json_fence` (`app/utils/llm_response_parsing.py`)** — pulls JSON out of a
  markdown-fenced model response. Used by every service that asks for JSON (survey, risk
  template, company profile, company sites, risk correlation, report content, survey PDF, threat
  intelligence, risk analysis). The copies it replaced shared two defects: splitting on the fence
  marker with a max-split of 1, which kept the closing fence in the payload, and a blanket
  `.replace("json", "")` intended to strip the fence's `json` language tag, which happily
  corrupted any occurrence of that word inside the content itself. It is deliberately
  fuzz-tested — five review rounds each surfaced a new edge case (backticks embedded in string
  values, trailing commentary after the closing fence, four-backtick fences, asymmetric
  nesting), which is the argument for one tested helper over nine hand-rolled parses (#148).
- **`llm_numeric_parsing` (`app/utils/llm_numeric_parsing.py`)** — parses numbers out of LLM
  JSON, safe against `Infinity` and `NaN`. Python's `json` module accepts both by default, so
  they reach service code as real floats and then propagate: `NaN` silently poisons every
  comparison and aggregate it touches, and `int(float('inf'))` raises `OverflowError` — not the
  `ValueError`/`TypeError` a defensive `except` around a numeric cast usually catches, so it
  crashed the whole request (#157, #160).

## Rate limiting — the real mechanism

`slowapi.Limiter`, **in-memory storage** (no `storage_uri` configured) — not Redis-backed, so
each worker process/replica enforces its own independent bucket. Two tiers: `expensive =
10/minute` (every LLM/upload endpoint) and `standard = 60/minute` (status polling, vector
delete).

Key function, in priority order:

1. Verified `X-Org-Token` → keys on the real `org_account_id` claim.
2. **`X-Organization` header** — self-reported, unauthenticated fallback. Explicitly and
   knowingly **not a security boundary**: since the only real auth (`X-Internal-Secret`) is
   shared across every caller, any caller can rotate this header per request to dodge the limit.
   Tests document this as accepted debt, not a bug.
3. Remote IP — final fallback.

Net effect: at any scale beyond one worker, the _effective_ per-org ceiling is `10/minute ×
(worker count)`, not a true global 10/minute.

## Knowledge-base pipeline detail

Upload → SHA-256 `file_id` (dedup; chosen over MD5 specifically to resist collision-spoofing) →
short-circuit if already in Pinecone → background OCR → chunk (1000/200 overlap) → batch-embed
(`text-embedding-3-large`) → upsert into an **org-specific Pinecone index** (name = sanitized
org username + a hashed suffix, collision-hardened) → fire-and-forget webhook +
notification to aexa-server.

**Per-page text is carried through chunking**, so each vector's `page_number` metadata is the
page its text actually came from. Every vector was previously stamped `page_number=1`
regardless of source, which doesn't degrade retrieval quality but does make every page citation
in a generated recommendation wrong — and confidently so, which is worse than no citation
(#152).

**Cost/DoS caps** (`config/config.yaml`): `max_images_per_file: 100` is enforced per **file**,
not per page — it read per-page, so a document's real ceiling was pages × 100 vision calls, and
there was no page cap at all to bound it. `max_pages_per_file: 300` now provides that bound
(generous for a full annual report, and processing happens in a background job after the
response returns, so the cap is about cost amplification rather than latency) (#153).

Job status backed by **Redis** (`SETEX`, 24h TTL) with an optional in-memory fallback if Redis
is unreachable (self-sweeping, capped, but invisible across replicas — a job started on one
worker can't be polled from another in fallback mode).

Status polling does a **defense-in-depth org check**: every job record is stamped with
`organization_username`; a mismatch against the caller's query param returns **404, not 403**,
specifically so it can't be used as a job-existence oracle. This exists because this endpoint's
only real auth is the shared secret — the actual org gate is aexa-server's own scoped DB lookup.

### Deleting vectors — everything keys on `file_id`

`DELETE /delete-vectors-by-filename` takes `file_id` and `file_name` in the **body** (not the
query string, keeping filenames out of access logs), and both the existence checks and the
delete itself key on `file_id`. Two things forced that, and they're worth knowing before
touching this endpoint:

- **`describe_index_stats(filter=...)` is silently ignored on Pinecone serverless indexes** —
  not an error, just an unfiltered response, so the pre- and post-delete existence checks were
  really answering "does this org have _any_ vectors" rather than "any for this file." They use
  `index.list(prefix=...)` instead, which works because vector ids are minted as
  `{file_id}-chunk-{n}` (#156).
- **`file_name` is not a stable key for a file's vectors.** `file_id` is the SHA-256 of the
  content, so the same PDF uploaded under two names dedupes to one `file_id` shared by two DB
  records — but every vector carries only the _first_ upload's `file_name`. Keying the delete on
  `file_name` while the existence check keyed on `file_id` meant the second record's delete
  matched zero vectors and reported a false 404 (#162). The two must stay on the same key.

## Known half-built / stubbed integration points

- **Upload-completion webhook payload has no `file_id`/job reference** — only
  `{pdf_name, pdf_size, organization_username}`. aexa-server can only correlate by
  `(organization_username, pdf_name)`, which breaks on a re-uploaded or renamed file. This is why
  aexa-server's `knowledge_base` webhook handler is a stub today (see
  [ai-intelligence.md](ai-intelligence.md)) — confirmed from both sides now.
- Two independently-configurable Pinecone API keys (`PINECONE_API_KEY` vs.
  `CLIENT_PINECONE_API_KEY`) split the RAG-query path from the upload path in code, but collapse
  to the same key in the common case (`.env.example` has the client key commented out) — unclear
  whether this split is used in ops or is unused scaffolding.
- `/report_content` is a fully real, working endpoint but wasn't part of the previously known
  aexa-server-side feature inventory — needs a follow-up to confirm its caller.

### Site-count extraction — open, awaiting a decision (aexa-ai#168)

`_extract_sites_count_from_answer` (`company_sites_service.py`) turns a Tavily search answer
into the site count the onboarding "Identify" stage seeds an org with. It has two paths:

- A **qualifier-anchored path** for "more than N sites" / "over N sites", which is well-hardened
  (#137): it anchors to the qualifier _and_ requires "site(s)" shortly after the number, so an
  earlier unrelated figure — a year, an employee count — can't win by being the leftmost match.
- A **no-qualifier fallback**, which is still a bare leftmost-number match. It will return a
  year, a percentage, or an employee count as the site count, which is exactly the #137 bug in
  the path #137 didn't cover.

**This is an open decision, not work in progress.** Five review rounds on the fallback each
found a genuine new edge case (backtracking through punctuation, decimals and reference
markers, then a semantic leftmost-match-vs-actual-count mismatch) without converging, and the
review loop stopped at its guardrail. PR #169 is open and unmerged; what's on `main` — and
described above — is the pre-#168 behavior. The question to settle isn't which regex, it's
whether this case should be a regex at all, or should route through the same LLM-based
extraction the structured path of this function already uses. Needs a product/engineering call
before anyone picks it up again.
