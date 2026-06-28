import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { AppError } from '../../utils/app_error.js';

const get_all_action_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 10;
  const searchTerm = (req.query.searchTerm as string) || '';
  const siteId = (req.query.siteId as string) || '';

  const skip = (page - 1) * limit;

  const whereCondition: Record<string, unknown> = {
    orgAccountId: user.accountId,
  };

  if (searchTerm) {
    whereCondition.actionTitle = { contains: searchTerm, mode: 'insensitive' };
  }
  if (siteId) {
    whereCondition.siteId = siteId;
  }

  const [data, total] = await Promise.all([
    prisma.action.findMany({
      where: whereCondition,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        messages: {
          select: {
            id: true,
            message: true,
            senderAccountId: true,
            createdAt: true,
            updatedAt: true,
            account: {
              select: {
                profile: { select: { fullName: true, profilePhoto: true } },
                organizationProfile: {
                  select: { organizationName: true, organizationLogo: true },
                },
              },
            },
          },
        },
        site: { select: { name: true, id: true } },
      },
    }),
    prisma.action.count({ where: whereCondition }),
  ]);

  return {
    meta: { page, limit, total, totalPage: Math.ceil(total / limit) },
    data,
  };
};

const get_single_action_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const { id } = req.params as Record<string, string>;
  const result = await prisma.action.findFirst({
    where: { id, orgAccountId: user.accountId },
    include: {
      messages: {
        select: {
          id: true,
          message: true,
          senderAccountId: true,
          createdAt: true,
          updatedAt: true,
          account: {
            select: {
              profile: { select: { fullName: true, profilePhoto: true } },
              organizationProfile: {
                select: { organizationName: true, organizationLogo: true },
              },
            },
          },
        },
      },
      site: { select: { name: true, id: true } },
    },
  });
  if (!result) throw new AppError('Action not found', 404);
  return result;
};

const create_action_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const body = req.body;

  const inspection = await prisma.inspection.findFirst({
    where: { id: body.inspectionId, orgAccountId: user.accountId },
  });
  if (!inspection) throw new AppError('Inspection not found', 404);
  body.siteId = inspection.siteId;

  const action = await prisma.action.create({
    data: {
      orgAccountId: user.accountId,
      inspectionId: body.inspectionId,
      siteId: body.siteId,
      questionId: body.questionId,
      actionTitle: body.actionTitle,
      actionDisc: body.actionDisc,
      priority: body.priority,
      dueDate: body.dueDate,
      status: body.status,
      messages: {
        create:
          body.messages?.map((msg: { message: string }) => ({
            senderAccountId: user.accountId,
            message: msg.message,
          })) || [],
      },
    },
    include: { messages: true },
  });

  return action;
};

const update_action_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.action.findFirst({ where: { id, orgAccountId: user.accountId } });
  if (!existing) throw new AppError('Action not found', 404);
  const result = await prisma.action.update({
    where: { id },
    data: {
      ...(req.body.actionTitle !== undefined && { actionTitle: req.body.actionTitle }),
      ...(req.body.actionDisc !== undefined && { actionDisc: req.body.actionDisc }),
      ...(req.body.priority !== undefined && { priority: req.body.priority }),
      ...(req.body.dueDate !== undefined && { dueDate: req.body.dueDate }),
      ...(req.body.status !== undefined && { status: req.body.status }),
    },
  });
  return result;
};

const delete_action_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.action.findFirst({ where: { id, orgAccountId: user.accountId } });
  if (!existing) throw new AppError('Action not found', 404);
  const result = await prisma.action.delete({ where: { id } });
  return result;
};

export const action_service = {
  get_all_action_from_db,
  get_single_action_from_db,
  create_action_into_db,
  update_action_into_db,
  delete_action_from_db,
};
