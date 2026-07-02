## What & why

<!-- One or two sentences. Link the ticket. -->

Closes #

## Type

- [ ] Feature
- [ ] Bug fix
- [ ] Refactor
- [ ] Chore / infra

## Definition of done

- [ ] Scoped to one task; branch is short-lived and rebased on latest `main`
- [ ] `npm run lint`, `npm run check`, and `npm run build` pass locally
- [ ] **Every DB read/write is scoped to the caller's org** (filter by `org_account_id` / `orgAccountId` — no lookups by raw `id` alone)
- [ ] **Auth middleware applied** to every new/changed route that needs it
- [ ] Request body validated with a real zod schema (no empty `z.object({})`)
- [ ] No secrets/keys committed; logging uses `pino`, not `console.*`
- [ ] I reviewed my own diff before requesting review

## How to test

<!-- Steps / requests for the reviewer to verify -->

## Notes for reviewer

<!-- Flag anything AI-assisted, risky, or worth a closer look -->
