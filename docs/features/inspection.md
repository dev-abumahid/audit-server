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
- **`InspectionAssignment`-based *write* scoping — wired (aexa-frontend#270).** A self-scoped
  `GET /inspection/assignments/mine` (added server-side in aexa-server#313, mirroring the
  existing `GET /action/assignments/mine`) returns the caller's own assignment rows, active and
  revoked. `src/hooks/useMyAssignments.ts` derives the active-id set from it, and
  `src/utils/assignmentScope.ts`'s `canWriteInspection` — a pure function mirroring
  `assertCanWriteToInspection` — gates the per-row Edit/Delete affordances in
  `InspectionTable.tsx`. A `LEAD_AUDITOR` now sees write controls only on inspections they're
  actually assigned to, instead of on every row.
  - **The hooks return `undefined` when assignment data is unavailable** (still loading, or the
    fetch failed), which every consumer reads as "degrade to the pre-#270 role-only behavior,"
    never as "known to have zero assignments." A failed fetch therefore can't newly lock a Lead
    Auditor out of their own work — it just returns the gate to the coarser rule it had before.
    An empty `Set` is the distinct "genuinely assigned to nothing" value.
- **Viewer *read* scoping is still server-only.** `resolveViewerVisibleIds` exists in
  `assignmentScope.ts` and correctly preserves the asymmetry (never-assigned Viewer → `null`,
  meaning org-wide fallback; every-assignment-revoked Viewer → empty `Set`, meaning denied), but
  nothing calls it — no list narrows a Viewer's visible rows client-side. #270 covered
  write-gating only.
- **Two write surfaces here are still open gaps.** `RunInspection.tsx` gates Save/Complete on the
  inspection's status alone, with no role or assignment check in the page itself
  (**aexa-frontend#275**). Its *route* is now guarded (see below), so a `VIEWER` no longer
  reaches it — but an unassigned `LEAD_AUDITOR` passes that role-level guard and gets a fully
  functional editing surface. Separately, the "Start New Inspection" button is still gated on the
  role-only `canWriteOrgResource`, so a `LEAD_AUDITOR` is offered it despite creation being
  ADMIN-only server-side (**aexa-frontend#276**).
- **Route-level guards on create/edit/run (aexa-frontend#271).** `audit/inspection/create`,
  `audit/inspection/update/:id` and `audit/inspections/:id` (run) are each wrapped in
  `WriteGuardRoute`, so a deep-linked `VIEWER` is redirected to the inspections list rather than
  reaching the form. The guard is role-only — it does not consult assignment state; that's the
  #275 half. See [frontend-overview.md](frontend-overview.md).
