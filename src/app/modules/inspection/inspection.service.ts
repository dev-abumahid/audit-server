import { Request } from 'express';
import { configs } from '../../configs/index.js';
import { prisma } from '../../lib/prisma.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { AppError } from '../../utils/app_error.js';
import uploadCloud from '../../utils/cloudinary.js';
import {
  applyInspectionScope,
  assertCanWriteToInspection,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import { AI_INTERNAL_SECRET_HEADER } from '../ai/ai.service.js';

const get_all_inspection_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  // query values
  const { status, searchTerm, siteId, page = '1', limit = '10' } = req.query;

  // pagination
  const currentPage = Number(page);
  const perPage = Number(limit);
  const skip = (currentPage - 1) * perPage;

  // dynamic where condition — filtered by the org's anchor account (see
  // org_scope.ts), not the caller's own accountId, so invited (non-anchor)
  // members see the org's data instead of their own empty slice of it.
  let whereCondition: any = {
    orgAccountId: ctx.organizationId,
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

  // Role scoping (issue #55 slice 3): Lead Auditor / scoped Viewer see only
  // their assigned inspections; unscoped Viewer and Admin see the org-wide
  // set already built above; Light User is denied (real scoping mechanism
  // ships in slice 4).
  whereCondition = await applyInspectionScope(whereCondition, ctx);

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
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as { id: string };
  const whereCondition = await applyInspectionScope({ id, orgAccountId: ctx.organizationId }, ctx);
  const result = await prisma.inspection.findFirst({
    where: whereCondition,
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
              questions: true,
            },
          },
        },
      },
      site: {
        select: {
          id: true,
          name: true,
        },
      },
      note: {
        select: {
          id: true,
        },
      },
    },
  });
  if (!result) throw new AppError('Inspection not found', 404);
  return result;
};

const create_inspection_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  // Judgment call (issue #55 slice 3): the spec says Lead Auditor can
  // "create/edit within scope", but a brand-new inspection has no
  // InspectionAssignment yet by definition — there's no scope for it to be
  // created "within". The simplest defensible reading is that inspection
  // creation stays ADMIN-only in this slice (the pre-slice-3 code didn't
  // gate creation by role at all, so this is a new restriction, not a
  // preserved one). Lead Auditors get inspections created for them and
  // then assigned; Viewers never create. Revisit if product wants
  // self-service inspection creation for auditors later.
  if (ctx.role !== 'ADMIN') {
    throw new AppError('Only organization admins can create inspections.', 403);
  }
  const body = req.body;

  // verify ownership of template and site — templates/sites are org-wide
  // for every role (CEO decision, out of scope for this slice's changes),
  // so these stay filtered by the org anchor account.
  const template = await prisma.template.findFirst({
    where: { id: body.templateId, orgAccountId: ctx.organizationId },
  });
  const site = await prisma.site.findFirst({
    where: { id: body.siteId, org_account_id: ctx.organizationId },
  });
  if (!template || !site) throw new AppError('Template or Site not found', 404);

  const result = await prisma.inspection.create({
    data: {
      orgAccountId: ctx.organizationId,

      templateId: template.id,
      siteId: site.id,
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
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as { id: string };
  const existing = await prisma.inspection.findFirst({
    where: { id, orgAccountId: ctx.organizationId },
  });
  if (!existing) throw new AppError('Inspection not found', 404);
  await assertCanWriteToInspection(ctx, id);
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
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as { id: string };
  const existing = await prisma.inspection.findFirst({
    where: { id, orgAccountId: ctx.organizationId },
  });
  if (!existing) throw new AppError('Inspection not found', 404);
  // Deletion stays ADMIN-only, same lifecycle-operation reasoning as
  // create_inspection_into_db above — a Lead Auditor's "edit within scope"
  // covers editing content, not removing the inspection outright.
  if (ctx.role !== 'ADMIN') {
    throw new AppError('Only organization admins can delete inspections.', 403);
  }
  const result = await prisma.inspection.delete({ where: { id } });
  return result;
};

const update_inspection_question_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as { id: string };
  const { answer, note, mediaFiles } = req.body;

  const existing = await prisma.questionAnswer.findUnique({
    where: { id },
    select: { inspectionId: true, inspection: { select: { orgAccountId: true } } },
  });

  if (!existing || existing.inspection.orgAccountId !== ctx.organizationId) {
    throw new AppError('Question answer not found', 404);
  }
  await assertCanWriteToInspection(ctx, existing.inspectionId);

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

const upload_any_file_into_aws_for_inspection = async (req: Request) => {
  const file = req.file;
  if (!file) {
    throw new AppError('File is required', 400);
  }
  const result = await uploadCloud(file);
  return result.secure_url;
};

const split_note_into_inspection_using_ai = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { inspectionId } = req.params as { inspectionId: string };

  // checking note available or not
  const isNoteExist = await prisma.note.findUnique({
    where: {
      inspectionId,
      orgAccountId: ctx.organizationId,
    },
    select: {
      extracted_text: true,
    },
  });

  // find inspection
  const isInspectionExist = await prisma.inspection.findUnique({
    where: {
      id: inspectionId,
      orgAccountId: ctx.organizationId,
    },
    select: {
      questionAnswers: {
        select: {
          id: true,
          question: {
            select: {
              question: true,
              answerType: true,
            },
          },
        },
      },
    },
  });

  if (!isInspectionExist || !isNoteExist) {
    throw new AppError('Inspection or Note not found', 404);
  }
  await assertCanWriteToInspection(ctx, inspectionId);

  // make ai payload
  const aiPayload = {
    extracted_text: isNoteExist.extracted_text,
    pages: [
      {
        questions: isInspectionExist.questionAnswers.map((item) => ({
          question: item.question.question,
          answerType: item.question.answerType,
          qestionAnswerId: item.id,
        })),
      },
    ],
  };

  // call ai api
  const aiResponse = await fetch(`${configs.ai_server_end_point}/extract-survey-answers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...AI_INTERNAL_SECRET_HEADER,
    },
    body: JSON.stringify(aiPayload),
  });
  if (!aiResponse.ok) {
    throw new AppError(`AI service error: ${aiResponse.status}`, 502);
  }
  const data = await aiResponse.json();

  if (data?.question?.length) {
    await Promise.all(
      data.question.map((item: any) =>
        prisma.questionAnswer.update({
          where: {
            id: item.qestionAnswerId,
          },
          data: {
            ...(item?.answer !== undefined &&
              item?.answer !== null && {
                answer: item.answer,
              }),
            ...(item?.note !== undefined &&
              item?.note !== null && {
                note: item.note,
              }),
          },
        }),
      ),
    );
  }

  if (data?.unsplited_text) {
    await prisma.inspection.update({
      where: {
        id: inspectionId,
      },
      data: {
        unSplitText: data?.unsplited_text,
      },
    });
  }

  return 'success fully splitted';
};

export const inspection_service = {
  get_all_inspection_from_db,
  get_single_inspection_from_db,
  create_inspection_into_db,
  update_inspection_into_db,
  delete_inspection_from_db,
  update_inspection_question_into_db,
  upload_any_file_into_aws_for_inspection,
  split_note_into_inspection_using_ai,
};
