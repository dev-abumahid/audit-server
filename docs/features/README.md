# Feature reference

Internal reference for what's actually implemented across the whole Qiyrix product — aexa-server
(backend), aexa-frontend (UI), and aexa-ai (the AI microservice) — organized by feature, written
from a user-standpoint ("what can someone do, and what rules govern it") rather than a
code-structure standpoint. The goal is to fight cognitive debt as the system grows past what any
one person holds in their head — this should describe **current behavior**, not aspiration.

**A backend capability with no frontend wiring is not a real user-facing feature yet.** Every
module doc below has a "Frontend wiring" section for exactly this reason. Most of the
methodology-driven backend features that once had no UI at all (KRI trend history, compliance
recurrence/re-attestation, finding Five Cs, finding-closure maker-checker, `GOVERNING_BODY`
classification, external light-user login) are now wired end-to-end. What's still backend-only,
along with the other open cross-cutting questions, is listed under "Known cross-cutting gaps"
below. Read a module's backend section and its frontend-wiring section together to know what's
actually shippable to a user today.

Keep it current: when a PR changes a workflow described here, update the relevant file in the
same PR. A stale doc is worse than no doc.

## Index

- [Cross-cutting concepts](cross-cutting.md) — auth model, org scoping, audit log, external/light-user access. **Read this first**, everything else depends on it.
- [aexa-frontend overview](frontend-overview.md) — routing/nav, role-gating behavior, auth/session model, frontend-only features
- [Risk register](risk.md) — inherent/residual scoring, maker-checker approval, risk-to-risk links, AI root-cause bucketing
- [KRIs](kri.md) — key risk indicators, trend history, threshold alerting, overdue detection
- [Findings / Actions](action-findings.md) — corrective actions & audit findings, sub-assignment, closure maker-checker
- [Compliance obligations](compliance.md) — obligations registry, evidence-gating, recurrence/re-attestation, scorecard
- [Inspections](inspection.md) — checklist runs, assignment-based edit scope, AI note-splitting
- [Governance & audit engagements](governance-audit.md) — Three Lines of Defense board, internal-audit engagements
- [AI & threat intelligence (aexa-server side)](ai-intelligence.md) — aexa-ai proxy layer, RSS threat scraping, promotion to Risk
- [aexa-ai service (the AI microservice itself)](ai-service.md) — every real endpoint, its actual mechanism (LLM/RAG/deterministic), auth, and rate limiting
- [Onboarding](onboarding.md) — zero-input tenant setup wizard (admin-only, not self-service — see doc)
- [Account & organization](account-organization.md) — signup/login, multi-user orgs, external light users
- [Reports](report.md) — AI-generated board risk reports
- [Other modules](other-modules.md) — Site, Template, Note, Recommendation, RiskLink, Alert, Notification, Knowledge Base, Profile

## Known cross-cutting gaps (as of this pass)

Worth a team look, not fixed as part of this docs pass:

- **Risk score overrides and staleness are invisible in the UI.** `inherent_is_override` /
  `*_override_reason` / `*_override_stale` are fully implemented server-side, but the frontend's
  `Risk` type carries none of them — no override toggle, no reason field, no staleness badge. If
  the backend marks a score stale after an input changes, nothing tells the user. See
  [risk.md](risk.md). This is the largest remaining backend-capability-with-no-UI gap.
- **Assignment-based scoping has no client-side counterpart.** `InspectionAssignment`
  (Lead-Auditor edit scope, Viewer visibility scope) and `FindingAssignment` (Light-User
  sub-assignment, with its own approval flow) are both real authorization mechanisms the
  frontend does not model at all. Client-side gating is role-only — `ADMIN`/`LEAD_AUDITOR` can
  write, `VIEWER`/`LIGHT_USER` cannot — which is correct-but-coarse: it never narrows a
  `LEAD_AUDITOR` to their assigned inspections, or a `LIGHT_USER` to their assigned findings, so
  those two roles can still meet a 403 on something the UI offered them. The server enforces the
  real rule in every case. See [inspection.md](inspection.md) and
  [action-findings.md](action-findings.md).
- **Deep-linked write routes are not role-guarded.** Role gating hides *affordances* on list and
  detail pages; the routes those affordances lead to (template create/edit, inspection
  create/edit, the run-inspection page) have no guard of their own, so a `VIEWER` who types or
  bookmarks the URL still reaches a full editing surface and only discovers the block on submit.
  See [frontend-overview.md](frontend-overview.md).
- **`Action.MessageVisibility` (`INTERNAL` / `CLIENT_VISIBLE`) exists on the schema with no
  enforcement anywhere** — a modeled concept, not a released feature. See
  [action-findings.md](action-findings.md).
- **Report *reads* have no org-role gate — an open product question, deliberately left
  unresolved.** Report *generation* is now correctly scoped (a scoped `LEAD_AUDITOR`'s report no
  longer pulls org-wide Action data), and publishing is ADMIN-only. But `GET /report`,
  `GET /report/:id`, and the signed-download route are gated only on account type, so any org
  member — including a `VIEWER` or `LIGHT_USER` — can read every generated board report. Whether
  that's correct is a product call (board reports are arguably org-wide-readable by design), not
  a bug with an obvious fix. Needs a decision before it's either closed or hardened. See
  [report.md](report.md).

### Open item needing a product/engineering decision

- **aexa-ai#168 — site-count fallback regex. Work has explicitly stopped pending a decision;
  this is not an in-progress fix.** `_extract_sites_count_from_answer` in
  `company_sites_service.py` (the onboarding "Identify" stage's site-count extraction) has a
  qualifier-anchored path for "more than N sites" / "over N sites" that is well-hardened, and a
  final no-qualifier fallback that is still a bare leftmost-number match — it will happily
  return a year, a percentage, or an employee count as the site count. Five review rounds each
  found a genuine new edge case (backtracking through punctuation, decimals and
  reference-markers, then a semantic leftmost-match-vs-actual-count mismatch) without the
  regex converging, and the review loop hit its guardrail. **PR #169 is open and unmerged; the
  regex on `main` is the pre-#168 version.** The decision to make is not "keep reviewing" — it's
  whether to keep refining a regex for this case at all, or route the no-qualifier fallback
  through the LLM-based extraction this same function already uses for the structured path.
  Needs Omar's input. See [ai-service.md](ai-service.md).

## How to read these docs

Each file favors concrete specifics over generic description: real field names, enum values,
and status transitions. Where a rule exists *because* of a specific product decision or a fixed
bug, that's noted — it's the part a generic code read won't tell you, and the part most likely
to get silently violated by a future change that doesn't know the history.
