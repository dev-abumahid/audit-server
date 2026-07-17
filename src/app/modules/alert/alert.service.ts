import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { assertCanWriteOrgResource, resolveCallerOrgContext } from '../../utils/org_scope.js';

const get_all_alert_from_db = async (req: Request) => {
  const {
    severity,
    is_read,
    kri_id,
    page = '1',
    limit = '10',
  } = req.query as Record<string, string>;
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const pageNumber = parseInt(page) || 1;
  const limitNumber = parseInt(limit) || 10;
  const skip = (pageNumber - 1) * limitNumber;

  const whereCondition: Record<string, unknown> = { org_account_id: ctx.organizationId };
  if (severity) whereCondition.severity = severity;
  if (is_read !== undefined) whereCondition.is_read = is_read === 'true';
  if (kri_id) whereCondition.kri_id = kri_id;

  const [data, total] = await Promise.all([
    prisma.alert.findMany({
      where: whereCondition,
      skip,
      take: limitNumber,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.alert.count({ where: whereCondition }),
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

const get_single_alert_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as Record<string, string>;
  const result = await prisma.alert.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!result) throw new AppError('Alert not found', 404);
  return result;
};

const create_alert_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const payload = req.body;

  if (payload.kri_id) {
    const kri = await prisma.kri.findFirst({
      where: { id: payload.kri_id, org_account_id: ctx.organizationId },
    });
    if (!kri) throw new AppError('KRI not found', 404);
  }

  const result = await prisma.alert.create({
    data: { ...payload, org_account_id: ctx.organizationId, ai_generated: false },
  });
  return result;
};

/**
 * Marking an alert read/unread is not gated by assertCanWriteOrgResource —
 * unlike creating or deleting an alert, this is a low-stakes per-viewer
 * acknowledgement action, not an edit to the underlying org resource, so
 * any active org member (any role) may do it.
 */
const mark_alert_read_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as Record<string, string>;
  const { is_read } = req.body as { is_read: boolean };

  const existing = await prisma.alert.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Alert not found', 404);

  const result = await prisma.alert.update({ where: { id }, data: { is_read } });
  return result;
};

const delete_alert_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as Record<string, string>;
  const existing = await prisma.alert.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Alert not found', 404);
  const result = await prisma.alert.delete({ where: { id } });
  return result;
};

export const alert_service = {
  get_all_alert_from_db,
  get_single_alert_from_db,
  create_alert_into_db,
  mark_alert_read_into_db,
  delete_alert_from_db,
};
