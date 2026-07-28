# Inspections

An `Inspection` is a completed/in-progress audit checklist run against a `Template`, at a
`Site`, optionally tied to a `Risk`.

## Assignment-based edit scope — `InspectionAssignment`

The same table backs two different purposes:
- **LEAD_AUDITOR edit scope**: an assigned Lead Auditor can edit an inspection's content; an
  unassigned one cannot.
- **VIEWER visibility scope**: an empty assignment-row set for a Viewer means org-wide
  visibility (see all); a populated set means scoped-only visibility.

Lead Auditor rows are always populated (there's no "org-wide edit" fallback for them the way
there is for Viewer visibility).

## Creation & deletion

Hard-restricted to ADMIN — a brand-new inspection has no assignment yet for anyone to be
"within scope" of.

## AI note-splitting

`split_note_into_inspection_using_ai` sends the inspection's extracted note text plus the
question list to aexa-ai's `/extract-survey-answers` endpoint, then writes back per-question
answers.

The ids aexa-ai echoes back are **re-verified against this inspection's own question-answer set
before anything is written**, and unmatched ones dropped with a warning rather than failing the
request (a mismatch is an aexa-ai-side data problem, not a reason to lose the whole split). This
matters because `QuestionAnswer` ids are globally unique, not org-scoped: writing straight to
whatever id came back meant a stale or mismatched one could silently overwrite a row in *any*
organization's inspection (#273).

## IDOR hardening

Every `questionAnswers[].questionId` submitted at creation is verified (batched) to belong to a
`Question` under the caller's own org before being attached. `inspectorProfileId` carries the
same org-ownership check as `templateId` and `siteId`. It was previously missing from the Zod
schema altogether, which meant Zod stripped it from the payload and the field was silently never
persisted — no error, no value (#279). A field absent from the validation schema is dropped, not
passed through; that's the failure mode to watch for when adding one.

## Permissions summary

| Action | Gate |
|---|---|
| Create / delete | ADMIN only |
| Edit content | ADMIN, or LEAD_AUDITOR if assigned via `InspectionAssignment` |
| View | scoped by `applyInspectionScope` (Viewer: org-wide unless assigned, deny if all assignments revoked) |

## Frontend wiring (aexa-frontend)

- CRUD, question-answer autosave, PDF export, note upload/extraction, and AI note-splitting are
  all fully wired. Start/Edit/Delete on the inspection list are gated to ADMIN/LEAD_AUDITOR —
  this module had no client-side gating at all while every sibling module did.
- **Answer autosave is per-question, and flushed before it can be lost.** Each question owns its
  own 600ms debounce timer, keyed by question id. A single shared timer meant answering a second
  question within the window cancelled the first question's pending save outright, silently
  discarding a typed answer. Two further loss paths close the same hole: **Complete** flushes all
  pending saves before submitting (otherwise the last answer entered was lost whenever Complete
  was clicked inside the debounce window), and **unmounting** flushes rather than discarding
  (navigating away mid-debounce dropped the answer with no indication). Overlapping callers
  share one in-progress flush, so a completion racing an unmount can't double-submit. If you
  add another way to leave this page, it needs to flush too.
- **List search is debounced against the query, not just the page reset.** Search previously
  fired a request per keystroke, and on a deep page could momentarily query e.g. page 7 of a
  freshly narrowed result set — rendering a false "no results" state before the page reset
  landed. Both the query term and the page reset now move together, off one delayed effect.
- **`InspectionAssignment`-based edit/view scoping — still absent.** The frontend's inspection
  type has no assignment concept at all (only a single `inspector` display field on the summary),
  so gating here is role-only: it hides write controls from `VIEWER`/`LIGHT_USER`, but never
  narrows a `LEAD_AUDITOR` to the inspections they're actually assigned to. The run-inspection
  page itself has no role guard either — it gates Save/Complete on the inspection's status alone,
  so anyone who deep-links to it reaches a full editing surface. The server enforces the real
  assignment rule in both cases. See [frontend-overview.md](frontend-overview.md).
