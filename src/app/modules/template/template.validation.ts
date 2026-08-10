import { z } from 'zod';

const AnswerTypeSchema = z.discriminatedUnion('answerType', [
  z.object({
    answerType: z.literal('input'),
    value: z.string().optional(),
  }),
  z.object({
    answerType: z.literal('multipleSelect'),
    value: z.union([z.array(z.string()), z.string()]).optional(),
  }),
  z.object({
    answerType: z.literal('date'),
    value: z.string().optional(),
  }),
  z.object({
    answerType: z.literal('media'),
    value: z.string().optional(),
  }),
  z.object({
    answerType: z.literal('checkbox'),
    value: z.union([z.boolean(), z.string()]).optional(),
  }),
  z.object({
    answerType: z.literal('slider'),
    value: z.union([z.number(), z.string()]).optional(),
  }),
  z.object({
    answerType: z.literal('number'),
    value: z.union([z.number(), z.string()]).optional(),
  }),
]);
const QuestionSchema = z.object({
  index: z.number().int().nonnegative(),
  question: z.string().min(1),
  isRequired: z.boolean(),

  answerType: AnswerTypeSchema,
});
const PageSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  title: z.string().min(1),
  questions: z.array(QuestionSchema).optional(),
});
const TemplateAccessSchema = z.object({
  userId: z.string().min(1),
});

const create_template = z.object({
  templateLogo: z.string().url().optional(),
  templateName: z.string().min(1),
  templateDisc: z.string().optional(),
  category: z.string().optional(),
  pages: z.array(PageSchema).min(1),
  access: z.array(TemplateAccessSchema).optional(),
});
const update_template = z.object({
  templateLogo: z.string().optional(),
  templateName: z.string().optional(),
  templateDisc: z.string().optional(),
  category: z.string().optional(),
});

const update_or_create_new_page = z.object({
  pageId: z.string().optional(),
  pageIndex: z.number().int().nonnegative(),
  title: z.string().optional(),
  templateId: z.string().optional(),
});

const update_or_create_new_question = z.object({
  index: z.number().int().nonnegative().optional(),
  question: z.string().optional(),
  isRequired: z.boolean().optional(),
  answerType: AnswerTypeSchema.optional(),
  pageId: z.string().optional(),
  questionId: z.string().optional(),
});

const send_template_access_invitation = z.object({
  templateId: z.string().min(1),
  userId: z.string().min(1),
});
export const template_validations = {
  create_template,
  update_template,
  update_or_create_new_page,
  update_or_create_new_question,
  send_template_access_invitation,
};
