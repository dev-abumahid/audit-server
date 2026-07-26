import { z } from 'zod';

// aexa-frontend#191 — POST /risk/root-cause-bucketing/create-action
//
// Mirrors one riskBucket's `groupedAction` shape from POST
// /risk/root-cause-bucketing's response (see risk.correlation.service.ts's
// RootCauseRiskBucket interface) plus `riskRefs`, which lives one level up
// on the bucket itself, not on groupedAction. The frontend is expected to
// pass groupedAction's fields through unmodified (this is a "send AI
// suggestion to a real record" action, not a free-form Action-create form),
// so every field here is required exactly where aexa-ai's response always
// populates it.
const GROUPED_ACTION_PRIORITY_ENUM = z.enum([
  'immediate',
  'short_term',
  'medium_term',
  'long_term',
]);

const create_action_from_bucket = z.object({
  description: z.string().min(1),
  normReference: z.string().min(1),
  owner: z.string().min(1),
  priority: GROUPED_ACTION_PRIORITY_ENUM,
  estimatedRiskReduction: z.number(),
  estimatedCost: z.string().min(1),
  timeline: z.string().min(1),

  // Which risks this bucket (and therefore this remediation) addresses.
  // Action has no many-to-many Risk relation today (see the design brief) —
  // these refs are folded into actionDisc as text, not persisted as a real
  // relation, so at least one is required for the resulting Action to say
  // anything about what it addresses.
  riskRefs: z.array(z.string().min(1)).min(1),
});

export const risk_correlation_validations = {
  create_action_from_bucket,
};
