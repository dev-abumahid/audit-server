import { Prisma } from '@prisma/client';
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
  requireTargetProfileInCallerOrg,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';
import { mapTemplateData } from './template.utils.js';

const get_all_template_from_db = async (req: Request) => {
  const { page, limit, searchTerm, category, status } = req.query as {
    page?: string;
    limit?: string;
    searchTerm?: string;
    category?: string;
    status?: string;
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

  if (category && category.trim() !== '') {
    whereCondition.category = category;
  }

  // Exact match against the TemplateStatus enum, same optional-param shape
  // as category/searchTerm above -- e.g. StartInspectionModal passes
  // status=PUBLISHED to exclude drafts from the inspection template picker.
  if (status === 'DRAFT' || status === 'PUBLISHED') {
    whereCondition.status = status;
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
        category: true,
        status: true,
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

// Suggest-from-existing-values source for the frontend's category input --
// intentionally a flat list of the org's own distinct, non-null category
// strings rather than a managed taxonomy (see template.prisma's comment on
// why `category` is a plain string, not a relational model).
const get_template_categories_from_db = async (req: Request) => {
  const user = req?.user as JwtPayload;
  const ctx = await resolveCallerOrgContext(user?.accountId);

  const rows = await prisma.template.findMany({
    where: { orgAccountId: ctx.organizationId, category: { not: null } },
    select: { category: true },
    distinct: ['category'],
    orderBy: { category: 'asc' },
  });

  return rows.map((r) => r.category).filter((c): c is string => !!c);
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
      // Postgres/Prisma give no ordering guarantee on a relation without an
      // explicit orderBy -- pageIndex/index exist specifically to define
      // display order (the frontend reorders by writing these), but nothing
      // sorted by them on read, so a migration or query-planner change
      // could silently scramble section/question order in the editor and
      // the PDF report.
      pages: {
        orderBy: { pageIndex: 'asc' },
        include: {
          questions: { orderBy: { index: 'asc' } },
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

  // In-use guard (found by audit): Inspection.template is onDelete: Cascade in
  // the schema, so deleting a template that still has inspections would
  // silently destroy those real audit records along with it. Block the delete
  // instead of cascading — a template referenced by any inspection must be
  // kept.
  const inspectionCount = await prisma.inspection.count({ where: { templateId: id } });
  if (inspectionCount > 0) {
    throw new AppError(
      `Cannot delete template: ${inspectionCount} inspection(s) reference it.`,
      409,
    );
  }

  const result = await prisma.template.delete({
    where: { id, orgAccountId: ctx.organizationId },
  });
  return result;
};

const duplicate_template_into_db = async (req: Request) => {
  const user = req?.user as JwtPayload;
  const ctx = await resolveCallerOrgContext(user?.accountId);
  assertCanWriteOrgResource(ctx);
  const { id } = req.params as { id: string };

  const source = await prisma.template.findFirst({
    where: { id, orgAccountId: ctx.organizationId },
    include: {
      pages: {
        orderBy: { pageIndex: 'asc' },
        include: { questions: { orderBy: { index: 'asc' } } },
      },
    },
  });
  if (!source) throw new AppError('Template not found', 404);

  // Duplicating a template is a fresh, private draft, not a snapshot of the
  // original's sharing state -- matching create_template_into_db, which
  // never populates `access` on creation either. Nested pages/questions are
  // real, structural copy-target data (the whole point of this endpoint);
  // `access` is per-user grant state that belongs to the original template's
  // owner relationships, not to a new copy nobody has reviewed yet.
  //
  // For the same reason, the copy always starts DRAFT regardless of the
  // source's own status -- a copy of a published template hasn't itself
  // been reviewed, so it shouldn't be immediately usable for real
  // inspections (see StartInspectionModal's status=PUBLISHED filter on
  // the frontend). Matches CreateTemplatePage.tsx's own new-template
  // default.
  const result = await prisma.template.create({
    data: {
      orgAccountId: ctx.organizationId,
      templateLogo: source.templateLogo,
      templateName: `${source.templateName} (copy)`,
      templateDisc: source.templateDisc,
      category: source.category,
      status: 'DRAFT',
      pages: {
        create: source.pages.map((page) => ({
          pageIndex: page.pageIndex,
          title: page.title,
          questions: {
            create: page.questions.map((q) => ({
              index: q.index,
              question: q.question,
              isRequired: q.isRequired,
              answerType: q.answerType,
              value: q.value === null ? Prisma.JsonNull : q.value,
            })),
          },
        })),
      },
    },
    include: {
      pages: {
        orderBy: { pageIndex: 'asc' },
        include: { questions: { orderBy: { index: 'asc' } } },
      },
    },
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

  // In-use guard (found by audit follow-up): deleting a Page cascade-deletes
  // its Questions (Question.page is onDelete: Cascade, template.prisma), and
  // each Question cascade-deletes its QuestionAnswers and Actions — the exact
  // hazard the question-level guard in delete_page_question_by_id_from_db
  // blocks, bypassable one level up via page deletion. Block the delete when
  // any question on this page is still in use, matching that guard.
  const [answerCount, actionCount] = await Promise.all([
    prisma.questionAnswer.count({ where: { question: { pageId: id } } }),
    prisma.action.count({ where: { question: { pageId: id } } }),
  ]);
  if (answerCount > 0 || actionCount > 0) {
    throw new AppError(
      `Cannot delete page: its questions have ${answerCount} answer(s) and ${actionCount} action(s) referencing them.`,
      409,
    );
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

  // In-use guard (found by audit): both QuestionAnswer.question
  // (prisma/schema/inspection.prisma:57) and Action.question
  // (prisma/schema/action.prisma:47) are onDelete: Cascade, so deleting a
  // question that has already been answered in an inspection — or that an
  // action is attached to — would silently destroy those answers/actions.
  // Block the delete when the question is still in use.
  const [answerCount, actionCount] = await Promise.all([
    prisma.questionAnswer.count({ where: { questionId: id } }),
    prisma.action.count({ where: { questionId: id } }),
  ]);
  if (answerCount > 0 || actionCount > 0) {
    throw new AppError(
      `Cannot delete question: ${answerCount} answer(s) and ${actionCount} action(s) reference it.`,
      409,
    );
  }

  return await prisma.question.delete({ where: { id } });
};

// requireTargetProfileInCallerOrg (verifies a TemplateAccess target's
// Profile.id belongs to the caller's org — issue #58) moved to org_scope.ts
// (imported above) once inspection.service.ts needed the identical check
// for create_inspection_into_db's body.inspectorProfileId (issue #279).

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
  get_template_categories_from_db,
  get_single_template_from_db,
  create_template_into_db,
  update_template_into_db,
  delete_template_from_db,
  duplicate_template_into_db,
  update_or_create_new_page_into_db,
  delete_template_page_by_id_from_db,
  update_or_delete_new_question_into_db,
  delete_page_question_by_id_from_db,
  add_template_access_member_into_db,
  remove_template_access_member_from_db,
};
