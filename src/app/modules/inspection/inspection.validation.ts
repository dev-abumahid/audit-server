import { z } from 'zod';

// Same restriction as Action.attachments (action.validation.ts) and for the
// same reason: z.string().url() alone accepts javascript:/data: schemes, and
// this field is set directly by the client (not just via the upload
// endpoint), so it's a real input-validation boundary, not just shape
// checking. Found by independent review.
const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'Attachment URL must be http(s)',
  });

export const QuestionAnswerSchema = z.object({
  questionId: z.string().uuid(),
  answer: z.any(),
  note: z.string().optional().nullable(),
  mediaFiles: z.any().optional(),
});

const create_inspection = z.object({
  templateId: z.string().uuid(),
  siteId: z.string().uuid(),
  questionAnswers: z.array(QuestionAnswerSchema),
});
const update_inspection = z.object({
  siteId: z.string().uuid().optional(),
  status: z.string().optional(),
  attachments: z.array(httpUrl).max(10).optional(),
});
const update_question_answer = z.object({
  answer: z.any(),
  note: z.string().optional().nullable(),
  mediaFiles: z.any(),
});

const assign_inspection_member = z.object({
  orgMemberId: z.string().min(1),
});

export const inspection_validations = {
  create_inspection,
  update_inspection,
  update_question_answer,
  assign_inspection_member,
};
