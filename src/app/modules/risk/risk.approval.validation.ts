import { z } from 'zod';

// A rejection must carry the reviewer's reason back to the submitter — the
// "returns with questions" behaviour from the Archer precedent (design doc
// 95). Submit/approve take no body beyond the path param, so they need no Zod
// schema.
const reject_risk = z.object({
  decisionNote: z.string().min(1, 'A rejection reason is required'),
});

export const risk_approval_validations = {
  reject_risk,
};
