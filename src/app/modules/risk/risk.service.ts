import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';

const get_all_risk_from_db = async (req: Request) => {
  const {
    searchTerm,
    siteId,
    category,
    page = '1',
    limit = '10',
  } = req.query as Record<string, string>;

  const user = req.user as JwtPayloadType;
  const pageNumber = parseInt(page) || 1;
  const limitNumber = parseInt(limit) || 10;
  const skip = (pageNumber - 1) * limitNumber;

  const whereCondition: any = {
    org_account_id: user.accountId,
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
    meta: {
      page: pageNumber,
      limit: limitNumber,
      total,
      totalPage: Math.ceil(total / limitNumber),
    },
    data,
  };
};

const get_single_risk_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const { id } = req.params as Record<string, string>;
  const result = await prisma.risk.findFirst({ where: { id, org_account_id: user.accountId } });
  if (!result) throw new AppError('Risk not found', 404);
  return result;
};

const create_risk_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const payload = req.body;
  payload.org_account_id = user.accountId;
  const result = await prisma.risk.create({ data: payload });
  return result;
};

const update_risk_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.risk.findFirst({ where: { id, org_account_id: user.accountId } });
  if (!existing) throw new AppError('Risk not found', 404);
  const result = await prisma.risk.update({ where: { id }, data: req.body });
  return result;
};

const delete_risk_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.risk.findFirst({ where: { id, org_account_id: user.accountId } });
  if (!existing) throw new AppError('Risk not found', 404);
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
