import { z } from 'zod';

const create_supplier = z.object({
  name: z.string().min(1).max(255),
  country: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
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

export const supplier_validations = {
  create_supplier,
  update_supplier,
  discover_suppliers,
};
