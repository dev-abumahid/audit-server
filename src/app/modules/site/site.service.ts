import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { JwtPayloadType } from '../../utils/JWT.js';

const get_all_site_from_db = async (req: Request) => {
  const { searchTerm, page = '1', limit = '10' } = req.query;
  const user = req.user as JwtPayloadType;

  const pageNumber = parseInt(page as string, 10) || 1;
  const limitNumber = parseInt(limit as string, 10) || 10;
  const skip = (pageNumber - 1) * limitNumber;

  const whereCondition: Prisma.SiteWhereInput = {
    org_account_id: user.accountId,
    ...(searchTerm && {
      OR: [
        {
          name: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
        {
          location: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
      ],
    }),
  };
  const [data, total] = await Promise.all([
    prisma.site.findMany({
      where: whereCondition,
      skip,
      take: limitNumber,
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        name: true,
        activity: true,
        location: true,
        country: true,
        employees_count: true,
        revenue: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.site.count({
      where: whereCondition,
    }),
  ]);

  return {
    data,
    meta: {
      page: pageNumber,
      limit: limitNumber,
      skip,
      total,
    },
  };
};

const get_single_site_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const id = req.params?.id as string;
  const result = await prisma.site.findUnique({ where: { id, org_account_id: user.accountId } });
  return result;
};

const create_site_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const payload = req.body;
  payload.org_account_id = user.accountId;
  const result = await prisma.site.create({ data: req.body });
  return result;
};

const update_site_into_db = async (req: Request) => {
  const id = req.params.id as string;
  const result = await prisma.site.update({ where: { id }, data: req.body });
  return result;
};

const delete_site_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const id = req.params.id as string;
  const result = await prisma.site.delete({ where: { id, org_account_id: user.accountId } });
  return result;
};

export const site_service = {
  get_all_site_from_db,
  get_single_site_from_db,
  create_site_into_db,
  update_site_into_db,
  delete_site_from_db,
};
