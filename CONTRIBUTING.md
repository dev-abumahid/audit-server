# Contributing & Team Working Agreement — AEXA Server

How we work together on this repo so a small, distributed team moves fast without
stepping on each other. Short on purpose. The companion web client is `aexa-frontend`.

---

## 1. How we divide work

- **One owner per module** — recorded in [`.github/CODEOWNERS`](.github/CODEOWNERS). To change a module you don't own, raise it with the owner first.
- **The API contract is the seam.** The Swagger docs at `/docs` are the agreed interface with the web client. Agree the request/response shape up front, then both sides build in parallel.
- **The CTO owns architecture, review, and standards** — not every line of code.

## 2. Branching & pull requests

- **One task → one short-lived branch → one small PR.** `feat/…`, `fix/…`, `chore/…`.
- **Conventional commits** (e.g. `feat(risk): scope queries to org`).
- **Rebase on `main` often**; merge daily.
- **Claim before you code:** assign the ticket and move it to _In Progress_ on [the board](https://github.com/orgs/Qiyrix/projects/1) first. This is how we avoid two people picking up the same task.

## 3. Definition of done

- [ ] `npm run lint`, `npm run check`, `npm run build` pass locally.
- [ ] **Every DB read/write is scoped to the caller's org** — filter by `org_account_id` / `orgAccountId`. Never look up, update, or delete by raw `id` alone. (See §4.)
- [ ] **Auth middleware** applied to every route that needs it.
- [ ] Request bodies validated with a real zod schema.
- [ ] No secrets committed; logging uses `pino`, not `console.*`.
- [ ] You reviewed your own diff before requesting review.

## 4. Security baseline (non-negotiable)

This product is multi-tenant. Two rules prevent customer-data leaks:

1. **Authenticate** — every non-public route uses `auth()` with the correct role.
2. **Authorize by tenant** — every query filters by the caller's org. A user from org A must never read or modify org B's data, even with a valid id. A query like `prisma.risk.update({ where: { id } })` is a bug; it must be `where: { id, org_account_id: user.accountId }`.

If you're unsure whether something is tenant-safe, ask in review.

## 5. Code review & AI use

- The **CTO reviews PRs**, targeting < 24h turnaround.
- **AI assistance is welcome** — same bar regardless of how code was written (CI + review). The author is accountable.
- Found a problem in someone else's module? **Raise it in review or a ticket** — don't silently rewrite it.

## 6. CI & deployment

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs **lint → typecheck → build** (after generating the Prisma client) on every PR. Must be green to merge.
- [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) builds the image and deploys to the VPS on merge to `main`. Because `main` deploys automatically, **nothing reaches `main` except through a reviewed, green PR.**

## 7. Cadence

- **Async daily standup** in chat: yesterday / today / blockers.
- **Weekly sync (Google Meet):** ~SF 7–8am · Luxembourg 16:00–17:00 · Bangladesh 20:00–21:00.

## 8. Local setup

```bash
npm ci                 # install (uses package-lock.json)
npx prisma generate    # generate the Prisma client (required before check/build)
npm run dev            # tsx watch
npm run lint
npm run check          # typecheck (tsc --noEmit)
npm run build
docker compose up      # postgres + redis
```

Configuration comes from a local `.env` (see the team secrets store) — never commit real secrets.
