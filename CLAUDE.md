# CLAUDE.md — aexa-server

Quick reference for AI coding assistants and new contributors.

## Stack

| Layer   | Tech                                              |
| ------- | ------------------------------------------------- |
| Runtime | Node.js, Express 5, TypeScript                    |
| ORM     | Prisma 7 (multi-schema, `prisma/schema/`)         |
| DB      | PostgreSQL (via `@prisma/adapter-pg`)             |
| Queues  | BullMQ + ioredis (`src/app/queues/`)              |
| Auth    | JWT (`src/app/utils/JWT.ts`) + Passport.js social |
| Logging | pino (`src/app/lib/logger.ts`)                    |
| Uploads | AWS S3 + Cloudinary                               |
| Docs    | Swagger (`/docs`)                                 |

## Dev commands

```bash
npm run dev        # tsx watch — restarts on save
npm run build      # tsc — produces dist/
npm run check      # tsc --noEmit — type-check only
npm run lint       # eslint
npm run lint:fix   # eslint --fix
npm run format     # prettier --write
```

No tests yet — `npm test` exits with an error. Vitest + Supertest is planned.

## Project layout

```
src/
  app.ts            # Express app (middleware, rate limiting, session)
  server.ts         # HTTP listen entry point
  routes.ts         # Top-level /api router
  app/
    configs/        # All env vars live in index.ts — never import process.env directly elsewhere
    lib/            # prisma.ts, logger.ts
    middlewares/    # auth.ts (JWT + verified check), global_error_handler.ts
    modules/        # One folder per domain (account, action, ai, inspection, recommendation, risk, site, template)
    passport-js/    # Social OAuth strategies
    queues/         # BullMQ queues and workers; connection.ts exports redisConnection
    utils/          # AppError, JWT helpers, response helpers
prisma/
  schema/           # One .prisma file per model (schema.prisma is the root)
  migrations/
```

## Adding a module

Every module follows the same four-file pattern:

```
modules/<name>/
  <name>.route.ts       # Express router, swagger JSDoc annotations
  <name>.controller.ts  # Thin: call service, call manageResponse()
  <name>.service.ts     # All DB and business logic
  <name>.validation.ts  # Zod schemas for request bodies
```

Wire the router in `src/routes.ts`.

## Auth middleware

```ts
import auth from '../middlewares/auth.ts';
router.get('/something', auth('ORGANIZATION'), controller);
```

`auth()` validates the JWT and checks `isAccountVerified` in the DB. It attaches `req.user` (`{ accountId, role, email, iat, exp }`).

Roles: `ADMIN`, `USER`, `ORGANIZATION`.

## Org scoping — critical

Every service query that touches tenant data **must** filter by the caller's org. Use `req.user.accountId` from the controller and pass it into the service.

Field naming is inconsistent across models — check the schema before writing a query:

| Models                                             | Field name                    |
| -------------------------------------------------- | ----------------------------- |
| action, recommendation, template, inspection, note | `orgAccountId` (camelCase)    |
| site, risk                                         | `org_account_id` (snake_case) |

Missing org scope = cross-tenant data leak. PRs that add queries without org scoping will be rejected.

## Error handling

Throw `AppError` for known errors:

```ts
import { AppError } from '../../utils/app_error.js';
throw new AppError('Not found', 404);
```

The global error handler in `src/app/middlewares/global_error_handler.ts` catches everything. Never send raw `err` objects or stack traces to clients in production.

## Environment variables

All vars are declared in `src/app/configs/index.ts`. Add new vars there — never read `process.env` directly in feature code.

Required vars that cause a hard startup failure if missing:

- `SESSION_SECRET` — express-session secret
- `AI_INTERNAL_SECRET` — shared secret sent as `X-Internal-Secret` on every outbound call to aexa-ai; must match aexa-ai's own `INTERNAL_SECRET`

Copy `.env.example` to `.env` to get started.

## Rate limiting

- `/api/auth/*` — 10 requests / 15 min per IP
- `/api/*` — 100 requests / 15 min per IP

Both use a Redis store backed by `redisConnection`.

## Prisma / DB notes

- Multi-schema setup: each domain has its own `.prisma` file; `schema.prisma` references them all.
- Run migrations with `npx prisma migrate dev`.
- Regenerate the client with `npx prisma generate` after schema changes.
- Do not import `PrismaClient` directly — use the singleton at `src/app/lib/prisma.ts`.

## Git / PR conventions

- Branch from `main`; name branches `feat/`, `fix/`, `chore/`
- PRs require a review from `@omartakadoum` (CTO) for anything in `src/app/middlewares/`, `src/app/modules/account/`, or `prisma/`
- Contractor feature branches go through `dev` first, then PR to `main`
- Never commit `.env` files, PDFs, images, or other binaries — uploads go to S3/Cloudinary
- Follow the PR template in `.github/pull_request_template.md`
