import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { assertCanWriteOrgResource, resolveCallerOrgContext } from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';

/**
 * aexa-frontend#142 — RiskLink CRUD. `source_ref`/`target_ref` are plain
 * strings (not real FKs — see risk.prisma's RiskLink comment for why), so
 * this is the one place enforcing that both actually resolve to a real,
 * org-scoped Risk row before a link is allowed to exist. Same "verify
 * org-scoped existence before accepting a reference" discipline as
 * create-risk's siteId validation (intelligence.service.ts,
 * aexa-frontend#141) and create-risk-from-item's siteId lookup.
 */
const assertRiskRefExists = async (orgAccountId: string, ref: string): Promise<void> => {
  const risk = await prisma.risk.findFirst({
    where: { org_account_id: orgAccountId, ref },
    select: { id: true, review_status: true },
  });
  if (!risk) {
    throw new AppError(`Risk with ref "${ref}" not found in this organization`, 404);
  }
  // docs/design-docs/ai-risk-review-approval-workflow.md, open item 1 --
  // linking to an explicitly-dismissed risk is almost certainly a mistake
  // (stale ref from before dismissal, or confusion about its status).
  // PENDING_REVIEW is allowed through deliberately -- an unreviewed AI risk
  // can still be a legitimate link target while awaiting review.
  if (risk.review_status === 'DISMISSED') {
    throw new AppError(`Risk with ref "${ref}" was dismissed and can't be linked`, 409);
  }
};

const create_risk_link_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  // Creating/deleting a risk-to-risk relationship is the same class of
  // action as editing a Risk itself — same ADMIN/LEAD_AUDITOR write gate
  // risk.service.ts's mutation endpoints already use.
  assertCanWriteOrgResource(ctx);

  const { source_ref, target_ref, link_type } = req.body as {
    source_ref: string;
    target_ref: string;
    link_type: 'CAUSES' | 'AMPLIFIES' | 'CORRELATES';
  };

  if (source_ref === target_ref) {
    throw new AppError('A risk cannot be linked to itself', 400);
  }

  // Both refs must exist in the caller's org before the link is accepted —
  // sequential, not Promise.all, purely so a single missing ref always
  // reports on source_ref first (deterministic error message), matching
  // this codebase's general preference for readable error text over
  // marginally faster parallel validation on a request this cheap.
  await assertRiskRefExists(ctx.organizationId, source_ref);
  await assertRiskRefExists(ctx.organizationId, target_ref);

  try {
    return await prisma.riskLink.create({
      data: {
        org_account_id: ctx.organizationId,
        source_ref,
        target_ref,
        link_type,
      },
    });
  } catch (error) {
    // Unique constraint on (org_account_id, source_ref, target_ref, link_type)
    // — the exact same link already exists. Surface as a clean 409, not a
    // raw 500 from an unhandled P2002.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError('This risk link already exists', 409);
    }
    throw error;
  }
};

const get_all_risk_links_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { source_ref, target_ref } = req.query as Record<string, string>;

  const whereCondition: {
    org_account_id: string;
    source_ref?: string;
    target_ref?: string;
  } = {
    org_account_id: ctx.organizationId,
  };
  if (source_ref) whereCondition.source_ref = source_ref;
  if (target_ref) whereCondition.target_ref = target_ref;

  // aexa-server#271: was an unconditional findMany with no limit, unlike
  // every other list endpoint in this codebase (note/recommendation/site/
  // template/kri/compliance/audit/action/risk/report all paginate) -- an
  // org with a large risk graph could serialize every RiskLink row in one
  // unbounded response.
  const pagination = paginationHelper({
    page: req.query.page as string,
    limit: req.query.limit as string,
  });
  const [data, total] = await Promise.all([
    prisma.riskLink.findMany({
      where: whereCondition,
      skip: pagination.skip,
      take: pagination.limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.riskLink.count({ where: whereCondition }),
  ]);

  return {
    data,
    meta: buildPaginationMeta(pagination, total),
  };
};

const delete_risk_link_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as Record<string, string>;

  const existing = await prisma.riskLink.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Risk link not found', 404);

  const result = await prisma.riskLink.delete({ where: { id } });
  return result;
};

export const risk_link_service = {
  create_risk_link_into_db,
  get_all_risk_links_from_db,
  delete_risk_link_from_db,
};
