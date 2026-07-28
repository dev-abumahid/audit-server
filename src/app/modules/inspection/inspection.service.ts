import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { configs } from '../../configs/index.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { AppError } from '../../utils/app_error.js';
import uploadCloud from '../../utils/cloudinary.js';
import {
  applyInspectionScope,
  assertCanWriteToInspection,
  assertIsOrgAdmin,
  recordOrgAuditEvent,
  requireCallerOrganizationId,
  requireTargetProfileInCallerOrg,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';
import { buildAiHeaders, fetchWithTimeout, LLM_CALL_TIMEOUT_MS } from '../ai/ai.service.js';

// aexa-frontend#191 review note: risk.correlation.service.ts's
// create_action_from_bucket lazily creates a synthetic per-org "AI-Generated
// Findings" Inspection (see that file's SYNTHETIC_TEMPLATE_NAME) to house
// AI-recommended actions that don't come from a real inspection run. This
// list endpoint has no filter excluding it, so it shows up mixed in with
// real inspections with no visual distinction. Deliberately not filtered
// here yet -- the actual UI treatment (hide it, badge it, or something
// else) is a frontend-stage decision (#191 stage 2), not a backend list-API
// change made unilaterally in the stage-1 PR. Flagging inline so this isn't
// silently forgotten.
const get_all_inspection_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  // query values
  const { status, searchTerm, siteId } = req.query;

  // pagination
  const pagination = paginationHelper({
    page: req.query.page as string,
    limit: req.query.limit as string,
  });
  const { skip, limit: perPage } = pagination;

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
    meta: buildPaginationMeta(pagination, total),
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

  // inspectorProfileId is optional client-supplied metadata (issue #279 —
  // it was missing from the Zod schema entirely, so it always wrote
  // `undefined` regardless of what the client sent; now that it's a real
  // field, it needs the same org-ownership guard templateId/siteId already
  // have above). Profile has no orgAccountId of its own, so "same org" is
  // resolved via the target Profile's account, same pattern already used
  // for TemplateAccess's body.userId (template.service.ts, issue #58).
  if (body.inspectorProfileId) {
    await requireTargetProfileInCallerOrg(body.inspectorProfileId, ctx.organizationId);
  }

  // Every questionAnswers[].questionId is client-supplied and was stored
  // with no check that it belongs to a Question under the caller's own org
  // — the same IDOR pattern already fixed for Action.questionId (issue #50).
  // A caller could otherwise supply a questionId belonging to a completely
  // different org's template, linking that org's question content to their
  // own inspection via the QuestionAnswer FK. Batched into a single count
  // query rather than one findFirst per item. Found by independent review
  // (issue #84).
  if (body.questionAnswers.length) {
    // `id: { in: [...] }` counts distinct matching rows — a repeated
    // questionId in the input (double-submit, a UI that doesn't dedupe)
    // would make `count` come back lower than the raw array length even
    // when every id IS legitimately owned, wrongly rejecting a valid
    // request. Compare against the deduplicated id count instead. Found by
    // independent review.
    const questionIds = [
      ...new Set(
        body.questionAnswers.map((item: { questionId: string }) => item.questionId) as string[],
      ),
    ];
    const ownedCount = await prisma.question.count({
      where: { id: { in: questionIds }, page: { template: { orgAccountId: ctx.organizationId } } },
    });
    if (ownedCount !== questionIds.length) {
      throw new AppError('One or more questions not found', 404);
    }
  }

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
      // attachments is a full-array replace, same as Action.attachments —
      // `undefined` check (not truthy) so an intentional empty-array clear
      // isn't silently dropped like a falsy siteId/status would be.
      ...(req.body.attachments !== undefined && { attachments: req.body.attachments }),
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
  const aiResponse = await fetchWithTimeout(
    `${configs.ai_server_end_point}/extract-survey-answers`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAiHeaders(ctx.organizationId),
      },
      body: JSON.stringify(aiPayload),
    },
    // Analysis call, not PDF processing — same tier as ai.service.ts's own
    // non-PDF calls (issue #275 follow-up to #233).
    LLM_CALL_TIMEOUT_MS,
  );
  if (!aiResponse.ok) {
    throw new AppError(`AI service error: ${aiResponse.status}`, 502);
  }
  const data = await aiResponse.json();

  if (data?.question?.length) {
    // aexa-ai's response echoes back qestionAnswerId values that are
    // supposed to be a subset of the ids we just sent it (all scoped to
    // this inspection via isInspectionExist above). But nothing on our side
    // enforces that — the `where: { id: item.qestionAnswerId }` used to
    // write directly to whatever id came back, with no check that it was
    // actually one of the ids sent, and no org/inspection scoping. Since
    // QuestionAnswer ids are global, a stale/mismatched id from aexa-ai
    // could silently overwrite an arbitrary row in ANY organization's
    // inspection. Same IDOR family as #50/#84 (create_inspection_into_db
    // above), applied here to the AI round-trip. A mismatch is an
    // aexa-ai-side data issue, not something that should hard-fail the
    // whole request, so we drop (not throw on) unmatched ids.
    const validQuestionAnswerIds = new Set(isInspectionExist.questionAnswers.map((qa) => qa.id));
    const validItems = data.question.filter((item: any) =>
      validQuestionAnswerIds.has(item?.qestionAnswerId),
    );
    const droppedCount = data.question.length - validItems.length;
    if (droppedCount > 0) {
      logger.warn(
        { inspectionId, droppedCount },
        'split_note_into_inspection_using_ai: dropped AI-returned qestionAnswerId(s) not belonging to this inspection',
      );
    }

    await Promise.all(
      validItems.map((item: any) =>
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

/**
 * Admin-only. Assigns an org member (any role — the assignment row is the
 * same mechanism used for both Lead Auditor's edit scope and Viewer's
 * optional visibility scope, see org_scope.ts) to an inspection.
 *
 * Without this endpoint, InspectionAssignment rows can never be created,
 * which makes LEAD_AUDITOR and scoped VIEWER completely inert — every list
 * comes back empty and every write 403s, since resolveCallerOrgContext +
 * getAssignedInspectionIds always resolve to zero assignments. Found by
 * independent code review of the read/write scoping added earlier in this
 * slice; this is the piece that actually makes assignment-based access
 * meaningful rather than a permanently-empty scope.
 */
const assign_member_to_inspection = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertIsOrgAdmin(ctx);
  const organizationId = await requireCallerOrganizationId(ctx);

  const { id: inspectionId } = req.params as { id: string };
  const { orgMemberId } = req.body as { orgMemberId: string };

  const inspection = await prisma.inspection.findFirst({
    where: { id: inspectionId, orgAccountId: ctx.organizationId },
  });
  if (!inspection) throw new AppError('Inspection not found', 404);

  const member = await prisma.orgMember.findFirst({
    where: { id: orgMemberId, organizationId },
  });
  if (!member) throw new AppError('Organization member not found', 404);

  // No plain unique constraint on (orgMemberId, inspectionId) anymore — a
  // revoked assignment shouldn't block re-assigning the same pair, so the
  // uniqueness is a partial index (revokedAt IS NULL) that Prisma's schema
  // DSL can't express, hence no generated compound-unique input for
  // upsert(). Look up the currently-active row explicitly instead.
  const existingActive = await prisma.inspectionAssignment.findFirst({
    where: { orgMemberId, inspectionId, revokedAt: null },
  });
  if (existingActive) return existingActive;

  // The findFirst-then-create above is still a check-then-act: two
  // concurrent assign requests for the same (orgMemberId, inspectionId)
  // pair can both miss each other's row and both attempt to create. The
  // partial unique index (revokedAt IS NULL) backs this at the DB level, so
  // catch the resulting P2002 and treat it the same as the existingActive
  // case above rather than letting it surface as a raw 500 — same pattern
  // as invite_member_into_db's identical race (organization.service.ts).
  // Found by independent review.
  let assignment;
  try {
    assignment = await prisma.inspectionAssignment.create({
      data: { orgMemberId, inspectionId, assignedById: user.accountId },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.inspectionAssignment.findFirst({
        where: { orgMemberId, inspectionId, revokedAt: null },
      });
      if (winner) return winner;
    }
    throw err;
  }

  // Never let an audit-log write fail the request it's logging — the
  // assignment above already committed, so an audit-insert error here must
  // not surface as a 500 for an otherwise-successful assignment.
  await recordOrgAuditEvent({
    organizationId,
    action: 'INSPECTION_ASSIGNMENT_CREATED',
    actorAccountId: user.accountId,
    subjectOrgMemberId: orgMemberId,
    metadata: { inspectionId, assignmentId: assignment.id },
  });

  return assignment;
};

const unassign_member_from_inspection = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertIsOrgAdmin(ctx);
  const organizationId = await requireCallerOrganizationId(ctx);

  const { id: inspectionId, orgMemberId } = req.params as {
    id: string;
    orgMemberId: string;
  };

  const inspection = await prisma.inspection.findFirst({
    where: { id: inspectionId, orgAccountId: ctx.organizationId },
  });
  if (!inspection) throw new AppError('Inspection not found', 404);

  // Org-scoped: mirrors assign_member_to_inspection's check on the way in.
  // Assignment rows can't cross orgs today (assign already enforces this),
  // so this is currently unreachable in practice, but without it an admin
  // could delete-by-guessed-id across orgs the moment any other code path
  // (a future bulk-assign, a migration, a bug) ever created a cross-org row.
  // Found by independent review.
  const member = await prisma.orgMember.findFirst({
    where: { id: orgMemberId, organizationId },
  });
  if (!member) throw new AppError('Organization member not found', 404);

  // Soft-revoke, not delete: an auditor investigating a disputed finding
  // needs to be able to answer "who was assigned to this inspection, and
  // who removed them, and when" — a hard delete destroys that history the
  // moment anyone is ever re-assigned or offboarded. Found by independent
  // review.
  const { count } = await prisma.inspectionAssignment.updateMany({
    where: { orgMemberId, inspectionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: user.accountId },
  });

  // Surfaced as a 404 rather than a blanket 200 — a caller unassigning
  // access they believe is live deserves to know when nothing was actually
  // revoked (stale UI, wrong orgMemberId, already unassigned), instead of
  // walking away believing access was cut off when it wasn't. Matches
  // action.service.ts's unassign_light_user_from_action. Found by
  // independent review.
  if (count === 0) {
    throw new AppError('No active assignment found for this member.', 404);
  }

  await recordOrgAuditEvent({
    organizationId,
    action: 'INSPECTION_ASSIGNMENT_REVOKED',
    actorAccountId: user.accountId,
    subjectOrgMemberId: orgMemberId,
    metadata: { inspectionId },
  });

  return { orgMemberId, inspectionId };
};

const get_inspection_assignments = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertIsOrgAdmin(ctx);
  // Kept consistent with assign/unassign's requireCallerOrganizationId call
  // even though the id itself isn't used below: without it, an ADMIN with
  // no OrgMember row (the ADMIN-of-self backward-compat fallback) could
  // list assignments here while assign/unassign both 403 for the same
  // caller — an inconsistent experience across the three assignment
  // endpoints for the same edge case. Found by independent review.
  await requireCallerOrganizationId(ctx);

  const { id: inspectionId } = req.params as { id: string };
  const inspection = await prisma.inspection.findFirst({
    where: { id: inspectionId, orgAccountId: ctx.organizationId },
  });
  if (!inspection) throw new AppError('Inspection not found', 404);

  return prisma.inspectionAssignment.findMany({
    where: { inspectionId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      orgMember: {
        select: {
          id: true,
          role: true,
          account: { select: { email: true, profile: { select: { fullName: true } } } },
        },
      },
    },
  });
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
  assign_member_to_inspection,
  unassign_member_from_inspection,
  get_inspection_assignments,
};
