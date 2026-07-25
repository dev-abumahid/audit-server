import { Router } from 'express';
import auth from '../../middlewares/auth.js';
import { governance_controller } from './governance.controller.js';

const router = Router();

// Read-only board, same auth level as every other module's GET / (any
// authenticated org member) — no assertCanWriteOrgResource gate here, since
// viewing the classification board isn't a write. Reassignment happens
// through each entity's own existing update endpoint (risk.route.ts,
// action.route.ts, kri.route.ts, compliance.route.ts, audit.route.ts), which
// already gate line_of_defense specifically to ADMIN/LEAD_AUDITOR.
router.get(
  '/three-lines-of-defense',
  auth('ORGANIZATION'),
  governance_controller.get_three_lines_of_defense,
);

export default router;
