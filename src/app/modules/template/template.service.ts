import { Request } from 'express';
import { JwtPayload } from 'jsonwebtoken';
import { prisma } from '../../lib/prisma.js';
import uploadCloud from '../../utils/cloudinary.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';
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
  const body = req?.body;
  if (body.pageId) {
    // UPDATE OLD ONE
    return await prisma.page.update({
      where: { id: body.pageId },
      data: {
        pageIndex: body.pageIndex,
        title: body.title,
      },
    });
  } else {
    // CREATE NEW ONE
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
  const id = req?.params?.id as string;
  return await prisma.page.delete({ where: { id } });
};

const update_or_delete_new_question_into_db = async (req: Request) => {
  const body = req?.body;

  // Update old question
  if (body.questionId) {
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
    // create new question
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
  const id = req?.params?.id as string;
  return await prisma.question.delete({ where: { id } });
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
};
