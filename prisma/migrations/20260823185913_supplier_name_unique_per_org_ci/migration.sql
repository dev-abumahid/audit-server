-- Case/whitespace-insensitive per-org uniqueness on Supplier.name.
--
-- Found by the aexa-frontend Supplier quality-bar-loop, round 7: the
-- frontend's own AI-discovery dedup (a client-side name Set, checked
-- before calling POST /supplier) was the ONLY thing preventing a
-- duplicate -- verified live that two identical-name POSTs both
-- succeeded with a plain 200, since this table had no constraint at all.
--
-- Uses LOWER(TRIM(name)) to match the frontend's own normalization
-- exactly (SupplierDiscoveryPanel.tsx's existingNames Set), so "Acme
-- Corp" and "  acme corp  " collide the same way on both sides. Prisma's
-- schema DSL has no functional-index syntax, so this is hand-added here
-- rather than expressed as @@unique in supplier.prisma -- same pattern
-- as FindingAssignment/InspectionAssignment's partial unique indexes.
CREATE UNIQUE INDEX "Supplier_org_account_id_name_ci_key"
    ON "Supplier" (org_account_id, LOWER(TRIM(name)));
