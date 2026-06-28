import { Request } from 'express';
import { JwtPayload } from 'jsonwebtoken';
import { prisma } from '../../lib/prisma.js';
import { TTemplateAccess } from '../../types/common.js';
import uploadCloud from '../../utils/cloudinary.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';
import { AppError } from '../../utils/app_error.js';
import { mapTemplateData } from './template.utils.js';

const get_all_template_from_db = async (req: Request) => {
  const { page, limit, searchTerm } = req.query as {
    page?: string;
    limit?: string;
    searchTerm?: string;
  };

  const user = req?.user as JwtPayload;

  const pagination = paginationHelper({ page, limit });

  // dynamic where
  const whereCondition: any = {
    orgAccountId: user?.accountId,
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
  const { id } = req.params as { id: string };
  const result = await prisma.template.findFirst({
    where: {
      id,
      orgAccountId: user?.accountId,
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

  return result;
};

const create_template_into_db = async (req: Request) => {
  const user = req?.user as JwtPayload;
  const body = req?.body;
  // check logo file
  if (req?.file) {
    const cloudRes = await uploadCloud(req?.file);
    body.templateLogo = cloudRes?.secure_url;
  }
  const payload = mapTemplateData(body, user?.accountId);
  const result = await prisma.template.create({ data: payload });
  return result;
};

const update_template_into_db = async (req: Request) => {
  const { id } = req.params as { id: string };
  const user = req?.user as JwtPayload;
  const body = req?.body;
  if (req?.file) {
    const cloudRes = await uploadCloud(req?.file);
    body.templateLogo = cloudRes?.secure_url;
  }

  const result = await prisma.template.update({
    where: { id, orgAccountId: user?.accountId },
    data: body,
  });
  return result;
};

const delete_template_from_db = async (req: Request) => {
  const user = req?.user as JwtPayload;
  const { id } = req.params as { id: string };
  const result = await prisma.template.delete({ where: { id, orgAccountId: user?.accountId } });
  return result;
};

// Upload par by part template section and question

const update_or_create_new_page_into_db = async (req: Request) => {
  const user = req?.user as JwtPayload;
  const body = req?.body;
  if (body.pageId) {
    // Verify page belongs to caller's org via parent template
    const page = await prisma.page.findFirst({
      where: { id: body.pageId },
      select: { template: { select: { orgAccountId: true } } },
    });
    if (!page || page.template.orgAccountId !== user.accountId) {
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
      where: { id: body.templateId, orgAccountId: user.accountId },
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
  const id = req?.params?.id as string;
  const page = await prisma.page.findFirst({
    where: { id },
    select: { template: { select: { orgAccountId: true } } },
  });
  if (!page || page.template.orgAccountId !== user.accountId) {
    throw new Error('Page not found');
  }
  return await prisma.page.delete({ where: { id } });
};

const update_or_delete_new_question_into_db = async (req: Request) => {
  const user = req?.user as JwtPayload;
  const body = req?.body;

  // Update old question
  if (body.questionId) {
    const question = await prisma.question.findFirst({
      where: { id: body.questionId },
      select: { page: { select: { template: { select: { orgAccountId: true } } } } },
    });
    if (!question || question.page.template.orgAccountId !== user.accountId) {
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
    if (!page || page.template.orgAccountId !== user.accountId) {
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
  const id = req?.params?.id as string;
  const question = await prisma.question.findFirst({
    where: { id },
    select: { page: { select: { template: { select: { orgAccountId: true } } } } },
  });
  if (!question || question.page.template.orgAccountId !== user.accountId) {
    throw new Error('Question not found');
  }
  return await prisma.question.delete({ where: { id } });
};

const add_template_access_member_into_db = async (req: Request) => {
  const body = req?.body as TTemplateAccess;
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
  const body = req?.body as TTemplateAccess;
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
