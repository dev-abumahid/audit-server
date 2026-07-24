import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { assertCanWriteOrgResource, resolveCallerOrgContext } from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';

const get_all_risk_from_db = async (req: Request) => {
  const { searchTerm, siteId, category } = req.query as Record<string, string>;

  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const pagination = paginationHelper({
    page: req.query.page as string,
    limit: req.query.limit as string,
  });
  const { skip, limit: limitNumber } = pagination;

  const whereCondition: any = {
    org_account_id: ctx.organizationId,
  };

  // search by name
  if (searchTerm) {
    whereCondition.name = {
      contains: searchTerm,
      mode: 'insensitive',
    };
  }

  // filter by site
  if (siteId) {
    whereCondition.site_id = siteId;
  }

  // filter by category
  if (category) {
    whereCondition.category = category;
  }

  const [data, total] = await Promise.all([
    prisma.risk.findMany({
      where: whereCondition,
      skip,
      take: limitNumber,
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        site: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    }),

    prisma.risk.count({
      where: whereCondition,
    }),
  ]);

  return {
    meta: buildPaginationMeta(pagination, total),
    data,
  };
};

const get_single_risk_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as Record<string, string>;
  const result = await prisma.risk.findFirst({ where: { id, org_account_id: ctx.organizationId } });
  if (!result) throw new AppError('Risk not found', 404);
  return result;
};

const create_risk_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const payload = req.body;
  payload.org_account_id = ctx.organizationId;
  const result = await prisma.risk.create({ data: payload });
  return result;
};

const update_risk_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.risk.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Risk not found', 404);
  // Never trust org_account_id from the request body on an update — see the
  // identical fix in site.service.ts's update_site_into_db for why.
  const { org_account_id: _ignored, ...safeBody } = req.body;
  const result = await prisma.risk.update({
    where: { id },
    data: { ...safeBody, org_account_id: ctx.organizationId },
  });
  return result;
};

const delete_risk_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.risk.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Risk not found', 404);

  // In-use guard (found by audit): Inspection.risk
  // (prisma/schema/inspection.prisma:34), Recommendation.risk
  // (prisma/schema/recommendation.prisma:21) and Kri.risk
  // (prisma/schema/kri.prisma:6) are all onDelete: Cascade, so deleting a
  // risk that inspections, recommendations or KRIs still reference would
  // silently destroy those records. Block the delete when the risk is still
  // in use.
  const [inspectionCount, recommendationCount, kriCount] = await Promise.all([
    prisma.inspection.count({ where: { riskId: id } }),
    prisma.recommendation.count({ where: { riskId: id } }),
    prisma.kri.count({ where: { risk_id: id } }),
  ]);
  if (inspectionCount > 0 || recommendationCount > 0 || kriCount > 0) {
    throw new AppError(
      `Cannot delete risk: ${inspectionCount} inspection(s), ${recommendationCount} recommendation(s) and ${kriCount} KRI(s) reference it.`,
      409,
    );
  }

  const result = await prisma.risk.delete({ where: { id } });
  return result;
};

export const risk_service = {
  get_all_risk_from_db,
  get_single_risk_from_db,
  create_risk_into_db,
  update_risk_into_db,
  delete_risk_from_db,
};
