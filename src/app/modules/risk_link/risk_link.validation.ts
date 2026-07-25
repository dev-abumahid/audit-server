import { z } from 'zod';

// Matches RiskLinkType in prisma/schema/risk.prisma exactly — confirmed
// against Fullbloom's real src/shared/types/domain.ts RiskLink type
// (CAUSES | AMPLIFIES | CORRELATES), not the "REVELE" placeholder from the
// initial brief (that string belongs to AuditFinding.link_type in
// Fullbloom, a different field entirely — see risk.prisma's RiskLink
// comment).
const LINK_TYPE_ENUM = z.enum(['CAUSES', 'AMPLIFIES', 'CORRELATES']);

const create_risk_link = z.object({
  source_ref: z.string().min(1, 'source_ref is required'),
  target_ref: z.string().min(1, 'target_ref is required'),
  link_type: LINK_TYPE_ENUM,
});

export const risk_link_validations = {
  create_risk_link,
};
