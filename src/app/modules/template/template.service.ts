import { Request } from 'express';
import { JwtPayload } from 'jsonwebtoken';
import { prisma } from '../../lib/prisma.js';
import { TTemplateAccess } from '../../types/common.js';
import { AppError } from '../../utils/app_error.js';
import uploadCloud from '../../utils/cloudinary.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import {
  assertCanWriteOrgResource,
  assertIsOrgAdmin,
  resolveAccountOrgAnchor,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';
import { mapTemplateData } from './template.utils.js';

const get_all_template_from_db = async (req: Request) => {
  const { page, limit, searchTerm } = req.query as {
    page?: string;
    limit?: string;
    searchTerm?: string;
  };

  const user = req?.user as JwtPayload;
  const ctx = await resolveCallerOrgContext(user?.accountId);

  const pagination = paginationHelper({ page, limit });

  // dynamic where
  const whereCondition: any = {
    orgAccountId: ctx.organizationId,
  };

  if (searchTerm && searchTerm.trim() !== '') {
    whereCondition.templateName = {
      contains: searchTerm,
      mode: 'insensitive',
    };
  }

  const [data, total] = await Promise.all([
    prisma.template.findMany({
      where: whereCondition,
      skip: pagination.skip,
      take: pagination.limit,
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        templateLogo: true,
        templateName: true,
        templateDisc: true,
        createdAt: true,
        updatedAt: true,
        access: {
          select: {
            userId: true,
          },
        },
      },
    }),

    prisma.template.count({
      where: whereCondition,
    }),
  ]);

  return {
    meta: buildPaginationMeta(pagination, total),
    data,
  };
};

const get_single_template_from_db = async (req: Request) => {
  const user = req?.user as JwtPayload;
  const ctx = await resolveCallerOrgContext(user?.accountId);
  const { id } = req.params as { id: string };
  const result = await prisma.template.findFirst({
    where: {
      id,
      orgAccountId: ctx.organizationId,
    },
    include: {
      pages: {
        include: {
          questions: true,
        },
      },
      access: true,
    },
  });

  // Every sibling module's get_single_* throws 404 for a missing/cross-org
  // record; this one returned a bare 200 with data: null instead. Found by
  // independent review.
  if (!result) throw new AppError('Template not found', 404);
  return result;
};

const create_template_into_db = async (req: Request) => {
  const user = req?.user as JwtPayload;
  const ctx = await resolveCallerOrgContext(user?.accountId);
  assertCanWriteOrgResource(ctx);
  const body = req?.body;
  // check logo file
  if (req?.file) {
    const cloudRes = await uploadCloud(req?.file);
    body.templateLogo = cloudRes?.secure_url;
  }
  const payload = mapTemplateData(body, ctx.organizationId);
  const result = await prisma.template.create({ data: payload });
  return result;
};

const update_template_into_db = async (req: Request) => {
  const { id } = req.params as { id: string };
  const user = req?.user as JwtPayload;
  const ctx = await resolveCallerOrgContext(user?.accountId);
  assertCanWriteOrgResource(ctx);
  const body = req?.body;
  if (req?.file) {
    const cloudRes = await uploadCloud(req?.file);
    body.templateLogo = cloudRes?.secure_url;
  }

  // Existence check before update, matching every sibling module — updating
  // a missing/cross-org id used to fall straight through to Prisma's raw
  // P2025 "record to update not found" error (a 500), instead of the clean
  // 404 the rest of the API returns for the same class of request. Found by
  // independent review (issue #60).
  const existing = await prisma.template.findFirst({
    where: { id, orgAccountId: ctx.organizationId },
  });
  if (!existing) throw new AppError('Template not found', 404);

  // Never trust orgAccountId from the request body on an update — Prisma
  // applies `data` as the SET clause independently of `where`, so a stray
  // orgAccountId here would reassign the row to a different org's anchor
  // account id regardless of the where-clause scoping above. Found by
  // independent review (same class of bug fixed in site/risk services).
  const { orgAccountId: _ignored, ...safeBody } = body;
  const result = await prisma.template.update({
    where: { id, orgAccountId: ctx.organizationId },
    data: { ...safeBody, orgAccountId: ctx.organizationId },
  });
  return result;
};

const delete_template_from_db = async (req: Request) => {
  const user = req?.user as JwtPayload;
  const ctx = await resolveCallerOrgContext(user?.accountId);
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as { id: string };
  // Existence check before delete, matching every sibling module — deleting
  // a missing/cross-org id used to fall straight through to Prisma's raw
  // P2025 "record to delete does not exist" error (a 500), instead of the
  // clean 404 the rest of the API returns for the same class of request.
  // Found by independent review.
  const existing = await prisma.template.findFirst({
    where: { id, orgAccountId: ctx.organizationId },
  });
  if (!existing) throw new AppError('Template not found', 404);
  const result = await prisma.template.delete({
    where: { id, orgAccountId: ctx.organizationId },
  });
  return result;
};

// Upload par by part template section and question

const update_or_create_new_page_into_db = async (req: Request) => {
  const user = req?.user as JwtPayload;
  const ctx = await resolveCallerOrgContext(user?.accountId);
  assertCanWriteOrgResource(ctx);
  const body = req?.body;
  if (body.pageId) {
    // Verify page belongs to caller's org via parent template
    const page = await prisma.page.findFirst({
      where: { id: body.pageId },
      select: { template: { select: { orgAccountId: true } } },
    });
    if (!page || page.template.orgAccountId !== ctx.organizationId) {
      throw new AppError('Page not found', 404);
    }
    return await prisma.page.update({
      where: { id: body.pageId },
      data: {
        pageIndex: body.pageIndex,
        title: body.title,
      },
    });
  } else {
    // Verify the target template belongs to caller's org before creating a page
    const template = await prisma.template.findFirst({
      where: { id: body.templateId, orgAccountId: ctx.organizationId },
    });
    if (!template) throw new AppError('Template not found', 404);
    return await prisma.page.create({
      data: {
        pageIndex: body.pageIndex,
        title: body.title,
        templateId: body.templateId,
      },
    });
  }
};

const delete_template_page_by_id_from_db = async (req: Request) => {
  const user = req?.user as JwtPayload;
  const ctx = await resolveCallerOrgContext(user?.accountId);
  assertCanWriteOrgResource(ctx);
  const id = req?.params?.id as string;
  const page = await prisma.page.findFirst({
    where: { id },
    select: { template: { select: { orgAccountId: true } } },
  });
  if (!page || page.template.orgAccountId !== ctx.organizationId) {
    throw new AppError('Page not found', 404);
  }
  return await prisma.page.delete({ where: { id } });
};

const update_or_delete_new_question_into_db = async (req: Request) => {
  const user = req?.user as JwtPayload;
  const ctx = await resolveCallerOrgContext(user?.accountId);
  assertCanWriteOrgResource(ctx);
  const body = req?.body;

  // Update old question
  if (body.questionId) {
    const question = await prisma.question.findFirst({
      where: { id: body.questionId },
      select: { page: { select: { template: { select: { orgAccountId: true } } } } },
    });
    if (!question || question.page.template.orgAccountId !== ctx.organizationId) {
      throw new AppError('Question not found', 404);
    }
    return prisma.question.update({
      where: { id: body.questionId },
      data: {
        index: body.index,
        question: body.question,
        isRequired: body.isRequired,
        answerType: body.answerType?.answerType,
        value: body.answerType?.value,
      },
    });
  } else {
    // Verify target page belongs to caller's org
    const page = await prisma.page.findFirst({
      where: { id: body.pageId },
      select: { template: { select: { orgAccountId: true } } },
    });
    if (!page || page.template.orgAccountId !== ctx.organizationId) {
      throw new AppError('Page not found', 404);
    }
    return prisma.question.create({
      data: {
        index: body.index,
        question: body.question,
        isRequired: body.isRequired,
        answerType: body.answerType?.answerType,
        value: body.answerType?.value,
        pageId: body.pageId,
      },
    });
  }
};

const delete_page_question_by_id_from_db = async (req: Request) => {
  const user = req?.user as JwtPayload;
  const ctx = await resolveCallerOrgContext(user?.accountId);
  assertCanWriteOrgResource(ctx);
  const id = req?.params?.id as string;
  const question = await prisma.question.findFirst({
    where: { id },
    select: { page: { select: { template: { select: { orgAccountId: true } } } } },
  });
  if (!question || question.page.template.orgAccountId !== ctx.organizationId) {
    throw new AppError('Question not found', 404);
  }
  return await prisma.question.delete({ where: { id } });
};

/**
 * Verifies a TemplateAccess target (Profile.id, via body.userId) belongs to
 * the same org as the caller — PR #56 fixed the templateId ownership check
 * on these two functions (issue #31), but neither verified the *target*
 * user, so an Admin who legitimately owns a template could still grant/
 * revoke access for a Profile.id belonging to an entirely different org, a
 * second, distinct cross-tenant vector. TemplateAccess.userId is a
 * Profile.id, not an Account.id or OrgMember.id, so "same org" is checked by
 * resolving the target Profile's own account's org anchor and comparing it
 * to the caller's.
 *
 * requireActive is opt-in, not baked into the same-org check itself — an
 * earlier version of this function resolved the target through
 * resolveCallerOrgContext (the caller-facing helper), which throws a 403 for
 * a merely-inactive (suspended/expired) target instead of the uniform 404
 * every other invalid userId here produces, AND made it impossible to ever
 * revoke a suspended member's leftover access (the revoke path can't allow
 * that to fail). resolveAccountOrgAnchor (org_scope.ts) resolves the same-org
 * fact without that throw, so the two independent facts — "same org" and
 * "currently active" — can be checked separately per call site. Found by
 * independent review (issue #58).
 */
const requireTargetProfileInCallerOrg = async (
  userId: string,
  callerOrganizationId: string,
  { requireActive = false }: { requireActive?: boolean } = {},
) => {
  const targetProfile = await prisma.profile.findUnique({
    where: { id: userId },
    select: { accountId: true },
  });
  if (!targetProfile) throw new AppError('User not found', 404);
  const target = await resolveAccountOrgAnchor(targetProfile.accountId);
  if (target.organizationId !== callerOrganizationId) {
    throw new AppError('User not found', 404);
  }
  if (requireActive && !target.isActive) {
    throw new AppError("This member's access to the organization is not active.", 400);
  }
};

const add_template_access_member_into_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertIsOrgAdmin(ctx);
  const body = req?.body as TTemplateAccess;
  // check template ownership
  const template = await prisma.template.findFirst({
    where: { id: body.templateId, orgAccountId: ctx.organizationId },
  });
  if (!template) throw new AppError('Template Not found', 404);

  // Granting NEW access to an inactive (suspended/expired) member is
  // pointless — they can't use it — so this path requires an active target,
  // unlike revoke below which must always be allowed to succeed regardless
  // of the target's current status.
  await requireTargetProfileInCallerOrg(body.userId, ctx.organizationId, { requireActive: true });

  // now assign member
  const res = await prisma.templateAccess.create({
    data: {
      templateId: body.templateId,
      userId: body.userId,
    },
  });

  // in future need to send notification email

  return res;
};

const remove_template_access_member_from_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertIsOrgAdmin(ctx);
  const body = req?.body as TTemplateAccess;

  // check template ownership
  const template = await prisma.template.findFirst({
    where: { id: body.templateId, orgAccountId: ctx.organizationId },
  });
  if (!template) throw new AppError('Template Not found', 404);

  // No requireActive here — revoking a suspended/offboarded member's
  // leftover access must always be allowed to succeed; only the same-org
  // fact matters for a revoke, not whether the target is currently active.
  await requireTargetProfileInCallerOrg(body.userId, ctx.organizationId);

  // Now remove member
  const res = await prisma.templateAccess.deleteMany({
    where: {
      userId: body.userId,
      templateId: body.templateId,
    },
  });
  return res;
};

export const template_service = {
  get_all_template_from_db,
  get_single_template_from_db,
  create_template_into_db,
  update_template_into_db,
  delete_template_from_db,
  update_or_create_new_page_into_db,
  delete_template_page_by_id_from_db,
  update_or_delete_new_question_into_db,
  delete_page_question_by_id_from_db,
  add_template_access_member_into_db,
  remove_template_access_member_from_db,
};
