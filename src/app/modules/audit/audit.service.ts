import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { assertCanWriteOrgResource, resolveCallerOrgContext } from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';

const get_all_audit_from_db = async (req: Request) => {
  const { searchTerm, page, limit } = req.query;
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);

  const pagination = paginationHelper({ page: page as string, limit: limit as string });
  const { skip, limit: limitNumber } = pagination;

  const whereCondition: Prisma.AuditEngagementWhereInput = {
    org_account_id: ctx.organizationId,
    ...(searchTerm && {
      OR: [
        {
          title: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
        {
          ref: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
        {
          lead_auditor: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    prisma.auditEngagement.findMany({
      where: whereCondition,
      skip,
      take: limitNumber,
      orderBy: {
        createdAt: 'desc',
      },
    }),
    prisma.auditEngagement.count({
      where: whereCondition,
    }),
  ]);

  return {
    data,
    meta: buildPaginationMeta(pagination, total),
  };
};

const get_single_audit_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const id = req.params?.id as string;
  const result = await prisma.auditEngagement.findUnique({
    where: { id, org_account_id: ctx.organizationId },
  });
  // Every sibling module's get_single_* throws 404 for a missing/cross-org
  // record rather than returning a bare 200 with data: null.
  if (!result) throw new AppError('Audit engagement not found', 404);
  return result;
};

const create_audit_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const payload = req.body;
  payload.org_account_id = ctx.organizationId;
  const result = await prisma.auditEngagement.create({ data: payload });
  return result;
};

const update_audit_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const id = req.params.id as string;
  const existing = await prisma.auditEngagement.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Audit engagement not found', 404);
  // Never trust org_account_id from the request body on an update — an
  // authorized (ADMIN/LEAD_AUDITOR) caller could otherwise reassign an
  // engagement to a different org's anchor account id, a cross-tenant
  // integrity issue even though ownership of the *existing* row was verified
  // above. Same guard site.service.ts applies. (RequestValidator already
  // strips org_account_id since it's not in the zod schema, but stripping it
  // here too keeps the service safe independent of the route wiring.)
  const { org_account_id: _ignored, ...safeBody } = req.body;
  const result = await prisma.auditEngagement.update({
    where: { id },
    data: { ...safeBody, org_account_id: ctx.organizationId },
  });
  return result;
};

const delete_audit_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const id = req.params.id as string;
  // Existence check before delete, matching every sibling module — deleting a
  // missing/cross-org id would otherwise fall through to Prisma's raw P2025
  // "record to delete does not exist" (a 500) instead of the clean 404 the
  // rest of the API returns. No in-use guard is needed here: nothing else in
  // the schema has an FK onto AuditEngagement (linked_risk_refs is a freeform
  // string array, not a relation), so there are no dependent rows to cascade.
  const existing = await prisma.auditEngagement.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Audit engagement not found', 404);
  const result = await prisma.auditEngagement.delete({
    where: { id, org_account_id: ctx.organizationId },
  });
  return result;
};

export const audit_service = {
  get_all_audit_from_db,
  get_single_audit_from_db,
  create_audit_into_db,
  update_audit_into_db,
  delete_audit_from_db,
};
