import { z } from 'zod';
export const QuestionAnswerSchema = z.object({
  questionId: z.string().uuid(),
  answer: z.any(),
  note: z.string().optional().nullable(),
  mediaFiles: z.any(),
});

const create_inspection = z.object({
  templateId: z.string().uuid(),
  siteId: z.string().uuid(),
  questionAnswers: z.array(QuestionAnswerSchema),
});
const update_inspection = z.object({
  siteId: z.string().uuid().optional(),
  status: z.string().optional(),
});
const update_question_answer = z.object({
  answer: z.any(),
  note: z.string().optional().nullable(),
  mediaFiles: z.any(),
});

export const inspection_validations = {
  create_inspection,
  update_inspection,
  update_question_answer,
};
