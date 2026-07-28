import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import {
  applyActionScope,
  assertCanWriteToInspection,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';

const get_all_recommendation_from_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  // Recommendations are 1:1 with an inspection, so they inherit the same
  // Lead Auditor/Viewer assignment scoping as Inspection/Action. Found by
  // independent review.
  const whereCondition = await applyActionScope(
    { orgAccountId: ctx.organizationId },
    ctx,
    'inspectionId',
  );

  // Was an unconditional findMany with no limit, unlike every other list
  // endpoint in this feature (site/template/risk all paginate). Found by
  // independent review.
  const pagination = paginationHelper({
    page: req.query.page as string,
    limit: req.query.limit as string,
  });
  const [data, total] = await Promise.all([
    prisma.recommendation.findMany({
      where: whereCondition,
      skip: pagination.skip,
      take: pagination.limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        siteId: true,
        riskId: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.recommendation.count({ where: whereCondition }),
  ]);

  return {
    data,
    meta: buildPaginationMeta(pagination, total),
  };
};

const get_single_recommendation_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as { id: string };
  const whereCondition = await applyActionScope(
    { id, orgAccountId: ctx.organizationId },
    ctx,
    'inspectionId',
  );
  const result = await prisma.recommendation.findFirst({
    where: whereCondition,
    include: { questions: true },
  });
  if (!result) throw new AppError('Recommendation not found', 404);
  return result;
};

const update_recommendation_answer_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const payload = req?.body;
  const { recQuestionId } = req.params as { recQuestionId: string };
  const existing = await prisma.recommendationResult.findFirst({
    where: { id: recQuestionId },
    include: { recommendationAi: { select: { orgAccountId: true, inspectionId: true } } },
  });
  if (!existing || existing.recommendationAi.orgAccountId !== ctx.organizationId) {
    throw new AppError('Recommendation question not found', 404);
  }
  await assertCanWriteToInspection(ctx, existing.recommendationAi.inspectionId);
  const result = await prisma.recommendationResult.update({
    where: { id: recQuestionId },
    data: {
      ...(payload?.observation !== undefined && { observation: payload.observation }),
      ...(payload?.standard !== undefined && { standard: payload.standard }),
      ...(payload?.recommendation !== undefined && { recommendation: payload.recommendation }),
    },
  });
  return result;
};

const update_recommendation_summary_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const payload = req?.body;
  const { recommendationId } = req.params as { recommendationId: string };
  const existing = await prisma.recommendation.findFirst({
    where: { id: recommendationId, orgAccountId: ctx.organizationId },
  });
  if (!existing) throw new AppError('Recommendation not found', 404);
  await assertCanWriteToInspection(ctx, existing.inspectionId);
  const result = await prisma.recommendation.update({
    where: { id: recommendationId },
    data: {
      ...(payload?.summary !== undefined && { summary: payload.summary }),
    },
  });
  return result;
};

const delete_recommendation_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as { id: string };
  const existing = await prisma.recommendation.findFirst({
    where: { id, orgAccountId: ctx.organizationId },
  });
  if (!existing) throw new AppError('Recommendation not found', 404);
  await assertCanWriteToInspection(ctx, existing.inspectionId);
  const result = await prisma.recommendation.delete({ where: { id } });
  return result;
};

const get_recommendation_by_inspectionId_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const inspectionId = req?.params?.inspectionId as string;
  const whereCondition = await applyActionScope(
    { inspectionId, orgAccountId: ctx.organizationId },
    ctx,
    'inspectionId',
  );
  const result = await prisma.recommendation.findFirst({
    where: whereCondition,
    include: { questions: true },
  });
  if (!result) throw new AppError('Recommendation not found', 404);
  return result;
};

export const recommendation_service = {
  get_all_recommendation_from_db,
  get_single_recommendation_from_db,
  update_recommendation_answer_into_db,
  delete_recommendation_from_db,
  get_recommendation_by_inspectionId_from_db,
  update_recommendation_summary_into_db,
};
