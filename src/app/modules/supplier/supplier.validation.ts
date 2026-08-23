import { z } from 'zod';

const SUPPLIER_RISK_TIER_ENUM = z.enum(['LOW', 'MEDIUM', 'HIGH']);
const SUPPLIER_STATUS_ENUM = z.enum(['ACTIVE', 'UNDER_REVIEW', 'INACTIVE']);
const SUPPLIER_CONTRACT_STATUS_ENUM = z.enum(['ACTIVE', 'EXPIRED', 'PENDING']);

// The frontend date input submits "" (empty string) when left blank, not
// null/undefined. z.coerce.date() would turn "" into an Invalid Date and
// reject the whole payload -- same optionalDate pattern as
// compliance.validation.ts/audit.validation.ts.
const optionalDate = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.coerce.date().optional(),
);

const create_supplier = z.object({
  name: z.string().min(1).max(255),
  country: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
  // Vendor-risk fields (aexa-frontend quality-bar-loop, industry-standards
  // axis) -- all optional, enrichment a reviewer fills in over time, not
  // required at creation. `status` has a schema-level default (ACTIVE, see
  // supplier.prisma) so it's safe to omit here too.
  risk_tier: SUPPLIER_RISK_TIER_ENUM.optional(),
  next_review_date: optionalDate,
  primary_contact_name: z.string().max(200).optional(),
  primary_contact_email: z.string().max(320).email().optional(),
  contract_status: SUPPLIER_CONTRACT_STATUS_ENUM.optional(),
  status: SUPPLIER_STATUS_ENUM.optional(),
  // Set when committing an accepted AI-discovered candidate from
  // POST /supplier/discover -- never set by a client for a hand-entered
  // supplier (the frontend only sends these two together, and only for
  // an accept action, never as free-form user input).
  ai_generated: z.boolean().optional(),
  source_info: z.string().max(2000).optional(),
});
const update_supplier = create_supplier.partial();

const discover_suppliers = z.object({
  company_name: z.string().min(1).max(200).optional(),
});

const bulk_update_status = z.object({
  supplierIds: z.array(z.string().uuid()).min(1, 'At least one supplier id is required'),
  status: SUPPLIER_STATUS_ENUM,
});

const bulk_delete = z.object({
  supplierIds: z.array(z.string().uuid()).min(1, 'At least one supplier id is required'),
});

export const supplier_validations = {
  create_supplier,
  update_supplier,
  discover_suppliers,
  bulk_update_status,
  bulk_delete,
};
