import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { JwtPayloadType } from '../../utils/JWT.js';

const get_all_inspection_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  // query values
  const { status, searchTerm, siteId, page = '1', limit = '10' } = req.query;

  // pagination
  const currentPage = Number(page);
  const perPage = Number(limit);
  const skip = (currentPage - 1) * perPage;

  // dynamic where condition
  const whereCondition: any = {
    orgAccountId: user.accountId,
  };

  // status filter
  if (status) {
    whereCondition.status = status;
  }

  // search by template name
  if (searchTerm) {
    whereCondition.template = {
      templateName: {
        contains: String(searchTerm),
        mode: 'insensitive',
      },
    };
  }

  // search by Site Id
  if (siteId) {
    whereCondition.siteId = siteId;
  }

  // total count
  const total = await prisma.inspection.count({
    where: whereCondition,
  });

  // data
  const result = await prisma.inspection.findMany({
    where: whereCondition,
    select: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      template: {
        select: {
          templateName: true,
          id: true,
        },
      },
      site: {
        select: {
          name: true,
          id: true,
        },
      },
      inspector: {
        select: {
          fullName: true,
          id: true,
        },
      },
    },
    skip,
    take: perPage,

    orderBy: {
      createdAt: 'desc',
    },
  });

  return {
    meta: {
      page: currentPage,
      limit: perPage,
      total,
      totalPage: Math.ceil(total / perPage),
    },

    data: result,
  };
};

const get_single_inspection_from_db = async (req: Request) => {
  // define your own logic here
  const { id } = req.params as { id: string };
  const result = await prisma.inspection.findUnique({
    where: { id },
    include: {
      questionAnswers: {
        include: {
          question: {
            select: {
              id: true,
              question: true,
              answerType: true,
              value: true,
            },
          },
        },
      },
      template: {
        include: {
          pages: {
            include: {
              questions: true
            }
          }
        }
      },
      site: {
        select: {
          id: true,
          name: true,
        }
      }
    },
  });
  return result;
};

const create_inspection_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const body = req.body;

  const result = await prisma.inspection.create({
    data: {
      orgAccountId: user.accountId,

      templateId: body.templateId,
      siteId: body.siteId,
      inspectorProfileId: body.inspectorProfileId,

      questionAnswers: {
        create: body.questionAnswers.map((item: any) => ({
          questionId: item.questionId,
          answer: item.answer,
          note: item.note,
          mediaFiles: item.mediaFiles,
        })),
      },
    },
    include: {
      questionAnswers: true,
    },
  });

  return result;
};

const update_inspection_into_db = async (req: Request) => {
  const { id } = req.params as { id: string };
  const result = await prisma.inspection.update({
    where: { id },
    data: {
      ...(req.body.siteId && { siteId: req.body.siteId }),
      ...(req.body.status && { status: req.body.status }),
    },
  });
  return result;
};

const delete_inspection_from_db = async (req: Request) => {
  const { id } = req.params as { id: string };
  const result = await prisma.inspection.delete({ where: { id } });
  return result;
};

const update_inspection_question_into_db = async (req: Request) => {
  const { id } = req.params as { id: string };
  const { answer, note, mediaFiles } = req.body;

  const existing = await prisma.questionAnswer.findUnique({
    where: { id },
  });

  if (!existing) {
    throw new Error('Question answer not found');
  }

  const result = await prisma.questionAnswer.update({
    where: { id },
    data: {
      ...(answer !== undefined && { answer }),
      ...(note !== undefined && { note }),
      ...(mediaFiles !== undefined && { mediaFiles }),
    },
  });

  return result;
};

export const inspection_service = {
  get_all_inspection_from_db,
  get_single_inspection_from_db,
  create_inspection_into_db,
  update_inspection_into_db,
  delete_inspection_from_db,
  update_inspection_question_into_db,
};
