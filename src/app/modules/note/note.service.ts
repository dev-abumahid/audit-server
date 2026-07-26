import { Request } from 'express';
import * as fs from 'fs';
import { configs } from '../../configs/index.js';
import { prisma } from '../../lib/prisma.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import {
  applyActionScope,
  assertCanWriteToInspection,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import { AppError } from '../../utils/app_error.js';
import uploadCloud from '../../utils/cloudinary.js';
import { logger } from '../../lib/logger.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';
import { buildAiHeaders } from '../ai/ai.service.js';

const get_all_note_from_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  // Notes are 1:1 with an inspection, so they inherit the same Lead
  // Auditor/Viewer assignment scoping as Inspection/Action — otherwise a
  // Lead Auditor restricted to inspection A could still read notes on
  // inspection B. Found by independent review.
  const whereCondition = await applyActionScope({ orgAccountId: ctx.organizationId }, ctx);

  // Was an unconditional findMany with no limit, unlike every other list
  // endpoint in this feature (site/template/risk all paginate). Found by
  // independent review.
  const pagination = paginationHelper({
    page: req.query.page as string,
    limit: req.query.limit as string,
  });
  const [data, total] = await Promise.all([
    prisma.note.findMany({
      where: whereCondition,
      skip: pagination.skip,
      take: pagination.limit,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.note.count({ where: whereCondition }),
  ]);

  return {
    data,
    meta: buildPaginationMeta(pagination, total),
  };
};

const get_single_note_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as { id: string };
  const whereCondition = await applyActionScope({ id, orgAccountId: ctx.organizationId }, ctx);
  const result = await prisma.note.findFirst({ where: whereCondition });
  if (!result) throw new AppError('Note not found', 404);
  return result;
};
const get_note_by_inspection_id_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { inspectionId } = req.params as { inspectionId: string };
  const whereCondition = await applyActionScope(
    { inspectionId, orgAccountId: ctx.organizationId },
    ctx,
  );
  const result = await prisma.note.findFirst({ where: whereCondition });
  if (!result) throw new AppError('Note not found', 404);
  return result;
};

const save_raw_note_into_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const body = req?.body;

  // verify caller owns the inspection this note is being attached to
  const inspection = await prisma.inspection.findFirst({
    where: { id: body.inspectionId, orgAccountId: ctx.organizationId },
  });
  if (!inspection) throw new AppError('Inspection not found', 404);
  await assertCanWriteToInspection(ctx, body.inspectionId);

  // check note exist or not
  const isNoteExist = await prisma.note.findFirst({
    where: { inspectionId: body.inspectionId, orgAccountId: ctx.organizationId },
  });
  if (isNoteExist) {
    throw new AppError('Note already exist', 400);
  }

  // db payload
  const payload = {
    ...body,
    orgAccountId: ctx.organizationId,
  };
  const result = await prisma.note.create({ data: payload });
  return result;
};

const extract_note_from_any_file_or_image_and_save_into_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const body = req?.body;
  const file = req?.file;

  // verify caller owns the inspection this note is being attached to
  const inspection = await prisma.inspection.findFirst({
    where: { id: body.inspectionId, orgAccountId: ctx.organizationId },
  });
  if (!inspection) throw new AppError('Inspection not found', 404);
  await assertCanWriteToInspection(ctx, body.inspectionId);

  // check note exist or not
  const isNoteExist = await prisma.note.findFirst({
    where: { inspectionId: body.inspectionId, orgAccountId: ctx.organizationId },
  });
  if (isNoteExist) {
    throw new AppError('Note already exist', 400);
  }
  // make ai Payload
  if (!file) {
    throw new AppError('File is required', 400);
  }

  // The AI-extraction step below reads the multer-written temp file but
  // never itself deletes it, so on a throw here (AI service error, JSON
  // parse failure) we must clean it up ourselves — otherwise the AppError
  // thrown for a non-ok aiResponse skips straight past any cleanup and
  // leaks the temp file on every failed extraction (#112).
  //
  // uploadCloud() (called further below, on success) already unlinks this
  // same file itself on both its own success and error paths (see
  // cloudinary.ts) — so this catch only covers the path where uploadCloud
  // is never reached. An outer `finally` around the whole function would
  // double-delete the file after uploadCloud already removed it, throwing
  // ENOENT and replacing a successful note-creation return with an error
  // (#112 follow-up, found by independent review).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  try {
    const fileBuffer = fs.readFileSync(file.path);
    const blob = new Blob([fileBuffer], {
      type: file.mimetype,
    });

    const formData = new FormData();

    formData.append('file', blob, file.originalname);

    const aiResponse = await fetch(`${configs.ai_server_end_point}/extract-text`, {
      method: 'POST',
      headers: buildAiHeaders(ctx.organizationId),
      body: formData,
    });
    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
    data = await aiResponse.json();
  } catch (err) {
    if (file?.path) {
      fs.unlinkSync(file.path);
    }
    throw err;
  }

  // Previously the uploaded file was read for AI text extraction and then
  // discarded — extracted_text survived but the original file itself was
  // never visible again (see #54: "I cannot visualize it"). Uploading it
  // here too means a failed/slow S3 upload doesn't block note creation from
  // the AI extraction that already succeeded above — attachments best-effort,
  // not a hard requirement for the note to exist.
  let attachments: string[] = [];
  try {
    const uploadResult = await uploadCloud(file);
    attachments = [uploadResult.secure_url];
  } catch (err) {
    // Swallowed deliberately: extraction already succeeded, and losing the
    // source-file attachment is strictly better than losing the note itself.
    // Still logged, same as the other best-effort operations in this
    // codebase (enqueueInviteEmailOrThrow, OrgAuditLog writes) — otherwise a
    // misconfigured S3/AWS setup silently produces attachment-less notes
    // forever with zero operational signal. Found by independent review.
    logger.error(
      { err, inspectionId: body.inspectionId },
      'Failed to upload note source file to S3',
    );
  }

  // db payload
  const payload = {
    ...data,
    orgAccountId: ctx.organizationId,
    inspectionId: body.inspectionId,
    attachments,
  };

  const result = await prisma.note.create({ data: payload });
  return result;
};

const update_note_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const body = req.body;
  const { id } = req.params as { id: string };

  const existing = await prisma.note.findFirst({ where: { id, orgAccountId: ctx.organizationId } });
  if (!existing) throw new AppError('Note not found', 404);
  await assertCanWriteToInspection(ctx, existing.inspectionId);

  const result = await prisma.note.update({
    where: { id },
    data: {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.extracted_text !== undefined && {
        extracted_text: body.extracted_text,
      }),
      // undefined check (not truthy), same as Action/Inspection.attachments —
      // an intentional empty-array clear must not be silently dropped.
      ...(body.attachments !== undefined && { attachments: body.attachments }),
    },
  });

  return result;
};

const delete_note_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { id } = req.params as { id: string };
  const existing = await prisma.note.findFirst({ where: { id, orgAccountId: ctx.organizationId } });
  if (!existing) throw new AppError('Note not found', 404);
  await assertCanWriteToInspection(ctx, existing.inspectionId);
  const result = await prisma.note.delete({ where: { id } });
  return result;
};

export const note_service = {
  get_all_note_from_db,
  get_single_note_from_db,
  save_raw_note_into_db,
  update_note_into_db,
  delete_note_from_db,
  extract_note_from_any_file_or_image_and_save_into_db,
  get_note_by_inspection_id_from_db,
};
