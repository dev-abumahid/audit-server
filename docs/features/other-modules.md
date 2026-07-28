# Other modules

Solid CRUD with consistent conventions — org-scoped, 404-not-500 on missing/cross-org ids,
delete-in-use guards where a cascade would silently destroy dependent records. No state
machines beyond what's already covered elsewhere.

## Site

Blocks delete if any Risk/Inspection/Action/Recommendation still references it.

## Template

Blocks delete if any Inspection references it.

## Page / Question (under Template)

Delete blocked if a Page/Question has already been answered/actioned.

## Note, Recommendation

Standard CRUD, no notable workflow. Both are read-scoped through `applyActionScope` with
`idField: 'inspectionId'` rather than the default — see
[action-findings.md](action-findings.md) for why the field has to be chosen per model.

## RiskLink

See [risk.md](risk.md) — enforces both `source_ref`/`target_ref` resolve to real, org-scoped
risks at write time (they're plain strings, not FKs).

`GET /risk-link` is paginated through the standard `paginationHelper` + `buildPaginationMeta`
pair like every sibling list endpoint. It was the one list route still returning an org's entire
link set unbounded — fine at demo scale, quietly not fine for an org with a dense correlation
graph (#271).

## Alert

Marking read/unread is deliberately **not** gated by the write-role check — any active member
may acknowledge an alert.

## Notification, Knowledge Base

Pure webhook receivers for the separate aexa-ai service (PDF→Pinecone embedding completion
signals). No `req.user`/org-scoping — auth is via a shared internal secret instead, since these
are service-to-service callbacks, not user-facing endpoints.

`knowledge_base`'s webhook is explicitly a stub today: aexa-ai's payload carries no org
identifier, so it only acknowledges receipt rather than persisting a completion signal (flagged
as a follow-up needed on the aexa-ai side, not something this repo can fix alone).
