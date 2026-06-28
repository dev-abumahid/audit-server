import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';

const get_all_recommendation_from_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const result = await prisma.recommendation.findMany({
    where: { orgAccountId: user.accountId },
    select: {
      id: true,
      siteId: true,
      riskId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return result;
};

const get_single_recommendation_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const { id } = req.params as { id: string };
  const result = await prisma.recommendation.findFirst({
    where: { id, orgAccountId: user.accountId },
    include: { questions: true },
  });
  if (!result) throw new AppError('Recommendation not found', 404);
  return result;
};

const update_recommendation_answer_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const payload = req?.body;
  const { recQuestionId } = req.params as { recQuestionId: string };
  const existing = await prisma.recommendationResult.findFirst({
    where: { id: recQuestionId },
    include: { recommendationAi: { select: { orgAccountId: true } } },
  });
  if (!existing || existing.recommendationAi.orgAccountId !== user.accountId) {
    throw new AppError('Recommendation question not found', 404);
  }
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
  const payload = req?.body;
  const { recommendationId } = req.params as { recommendationId: string };
  const existing = await prisma.recommendation.findFirst({
    where: { id: recommendationId, orgAccountId: user.accountId },
  });
  if (!existing) throw new AppError('Recommendation not found', 404);
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
  const { id } = req.params as { id: string };
  const existing = await prisma.recommendation.findFirst({
    where: { id, orgAccountId: user.accountId },
  });
  if (!existing) throw new AppError('Recommendation not found', 404);
  const result = await prisma.recommendation.delete({ where: { id } });
  return result;
};

const get_recommendation_by_inspectionId_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const inspectionId = req?.params?.inspectionId as string;
  const result = await prisma.recommendation.findFirst({
    where: { inspectionId, orgAccountId: user.accountId },
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
