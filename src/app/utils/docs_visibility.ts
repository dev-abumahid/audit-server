// Split out from app.ts (issue #38) so this decision is unit-testable
// against a real import, not a duplicate reimplementation. app.ts itself
// can't be imported directly in a lightweight test -- it does heavy eager
// work at module load (Redis-backed rate limiters, a hard throw if
// SESSION_SECRET/AI_INTERNAL_SECRET are unset) -- but this predicate has no
// such dependency, so it can be imported as-is by both app.ts and its test.
export function isDocsRouteEnabled(env: string | undefined): boolean {
  return env !== 'production';
}
