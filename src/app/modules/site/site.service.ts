import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { assertCanWriteOrgResource, resolveCallerOrgContext } from '../../utils/org_scope.js';

const get_all_site_from_db = async (req: Request) => {
  const { searchTerm, page = '1', limit = '10' } = req.query;
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);

  const pageNumber = parseInt(page as string, 10) || 1;
  const limitNumber = parseInt(limit as string, 10) || 10;
  const skip = (pageNumber - 1) * limitNumber;

  const whereCondition: Prisma.SiteWhereInput = {
    org_account_id: ctx.organizationId,
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
  const ctx = await resolveCallerOrgContext(user.accountId);
  const id = req.params?.id as string;
  const result = await prisma.site.findUnique({
    where: { id, org_account_id: ctx.organizationId },
  });
  return result;
};

const create_site_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const payload = req.body;
  payload.org_account_id = ctx.organizationId;
  const result = await prisma.site.create({ data: req.body });
  return result;
};

const update_site_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const id = req.params.id as string;
  const existing = await prisma.site.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Site not found', 404);
  // Never trust org_account_id from the request body on an update — an
  // authorized (ADMIN/LEAD_AUDITOR) caller could otherwise reassign a Site
  // to a different org's anchor account id, a cross-tenant integrity issue
  // even though ownership of the *existing* row was verified above. Found
  // by independent review.
  const { org_account_id: _ignored, ...safeBody } = req.body;
  const result = await prisma.site.update({
    where: { id },
    data: { ...safeBody, org_account_id: ctx.organizationId },
  });
  return result;
};

const delete_site_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const id = req.params.id as string;
  const result = await prisma.site.delete({ where: { id, org_account_id: ctx.organizationId } });
  return result;
};

export const site_service = {
  get_all_site_from_db,
  get_single_site_from_db,
  create_site_into_db,
  update_site_into_db,
  delete_site_from_db,
};
