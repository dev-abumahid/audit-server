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

// quality-bar-loop (Inspections, round 3, security finding): mediaFiles
// entries are always `{ url, type }` attachment references (see
// CreateNewInspection.tsx/UpdateInspection.tsx on the frontend) rendered
// straight into <img src>/<video><source src>/<a href>/window.open with no
// further sanitization (InspectionReport.tsx). They were previously
// z.any(), unlike Inspection.attachments, which already got this same
// httpUrl scheme check after an earlier independent review specifically to
// reject javascript:/data: schemes. `answer` itself is intentionally left
// as z.any() here — it's polymorphic per question type (text/number/
// boolean/etc, not just media), so a scheme check at this layer would
// reject legitimate non-URL answers.
const mediaFileSchema = z.object({
  url: httpUrl,
  type: z.string(),
});

export const QuestionAnswerSchema = z.object({
  questionId: z.string().uuid(),
  answer: z.any(),
  note: z.string().optional().nullable(),
  mediaFiles: z.array(mediaFileSchema).optional(),
});

const create_inspection = z.object({
  templateId: z.string().uuid(),
  siteId: z.string().uuid(),
  // Optional metadata (who performed the inspection), matching
  // Inspection.inspectorProfileId's nullable/optional Prisma column
  // (prisma/schema/inspection.prisma) — not every inspection has an
  // inspector assigned at creation time. Was missing entirely from this
  // schema, so Zod's default unknown-key stripping (request_validator.ts)
  // silently dropped whatever the client sent and the service always wrote
  // `undefined` regardless of the request body (issue #279).
  inspectorProfileId: z.string().uuid().optional(),
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
  mediaFiles: z.array(mediaFileSchema).optional(),
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
