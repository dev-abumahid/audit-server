import { z } from 'zod';

// POST /intelligence/analyze — an explicit list of IntelligenceItem ids, or
// omitted/empty entirely meaning "all currently un-analyzed items for this
// org" (see intelligence.service.ts's analyze_items_into_db).
const analyze_items = z.object({
  itemIds: z.array(z.string()).optional(),
});

const create_risk_from_item = z.object({
  // No body fields required — every field the created Risk needs comes from
  // the already-analyzed IntelligenceItem itself (see the field-mapping
  // decision documented in intelligence.service.ts's create_risk_from_item_into_db
  // and the PR description). Kept as an object (not z.object({}).strict())
  // so an empty JSON body `{}` (what a client with no fields to send
  // naturally sends) always validates.
});

export const intelligence_validations = {
  analyze_items,
  create_risk_from_item,
};
