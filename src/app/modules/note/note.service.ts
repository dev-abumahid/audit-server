import { Request } from 'express';
import * as fs from 'fs';
import { configs } from '../../configs/index.js';
import { prisma } from '../../lib/prisma.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { AppError } from '../../utils/app_error.js';
import { AI_INTERNAL_SECRET_HEADER } from '../ai/ai.service.js';

const get_all_note_from_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  // define your own logic here
  const result = await prisma.note.findMany({
    where: {
      orgAccountId: user.accountId,
    },
  });
  return result;
};

const get_single_note_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const { id } = req.params as { id: string };
  const result = await prisma.note.findFirst({ where: { id, orgAccountId: user.accountId } });
  if (!result) throw new AppError('Note not found', 404);
  return result;
};
const get_note_by_inspection_id_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const { inspectionId } = req.params as { inspectionId: string };
  const result = await prisma.note.findFirst({
    where: { inspectionId, orgAccountId: user.accountId },
  });
  if (!result) throw new AppError('Note not found', 404);
  return result;
};

const save_raw_note_into_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const body = req?.body;

  // verify caller owns the inspection this note is being attached to
  const inspection = await prisma.inspection.findFirst({
    where: { id: body.inspectionId, orgAccountId: user.accountId },
  });
  if (!inspection) throw new AppError('Inspection not found', 404);

  // check note exist or not
  const isNoteExist = await prisma.note.findFirst({
    where: { inspectionId: body.inspectionId, orgAccountId: user.accountId },
  });
  if (isNoteExist) {
    throw new AppError('Note already exist', 400);
  }

  // db payload
  const payload = {
    ...body,
    orgAccountId: user.accountId,
  };
  const result = await prisma.note.create({ data: payload });
  return result;
};

const extract_note_from_any_file_or_image_and_save_into_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const body = req?.body;
  const file = req?.file;

  // verify caller owns the inspection this note is being attached to
  const inspection = await prisma.inspection.findFirst({
    where: { id: body.inspectionId, orgAccountId: user.accountId },
  });
  if (!inspection) throw new AppError('Inspection not found', 404);

  // check note exist or not
  const isNoteExist = await prisma.note.findFirst({
    where: { inspectionId: body.inspectionId, orgAccountId: user?.accountId },
  });
  if (isNoteExist) {
    throw new AppError('Note already exist', 400);
  }
  // make ai Payload
  if (!file) {
    throw new AppError('File is required', 400);
  }
  const fileBuffer = fs.readFileSync(file.path);
  const blob = new Blob([fileBuffer], {
    type: file.mimetype,
  });

  const formData = new FormData();

  formData.append('file', blob, file.originalname);

  const aiResponse = await fetch(`${configs.ai_server_end_point}/extract-text`, {
    method: 'POST',
    headers: AI_INTERNAL_SECRET_HEADER,
    body: formData,
  });
  if (!aiResponse.ok) {
    throw new AppError(`AI service error: ${aiResponse.status}`, 502);
  }
  const data = await aiResponse.json();

  // db payload
  const payload = {
    ...data,
    orgAccountId: user.accountId,
    inspectionId: body.inspectionId,
  };

  const result = await prisma.note.create({ data: payload });
  return result;
};

const update_note_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const body = req.body;
  const { id } = req.params as { id: string };

  const existing = await prisma.note.findFirst({ where: { id, orgAccountId: user.accountId } });
  if (!existing) throw new AppError('Note not found', 404);

  const result = await prisma.note.update({
    where: { id },
    data: {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.extracted_text !== undefined && {
        extracted_text: body.extracted_text,
      }),
    },
  });

  return result;
};

const delete_note_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const { id } = req.params as { id: string };
  const existing = await prisma.note.findFirst({ where: { id, orgAccountId: user.accountId } });
  if (!existing) throw new AppError('Note not found', 404);
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
