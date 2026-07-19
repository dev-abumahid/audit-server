import { z } from 'zod';

// z.string().url() alone accepts any URL the WHATWG URL constructor parses,
// which includes javascript:/data: schemes — not just http(s). Attachment
// URLs are rendered as links/images, so the scheme itself must be checked,
// not just "is this URL-shaped".
const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'Attachment URL must be http(s)',
  });

const PRIORITY_ENUM = z.enum(['Low', 'Medium', 'High']);

const STATUS_ENUM = z.enum(['TO_DO', 'IN_PROGRESS', 'COMPLETE', 'CANT_DO']);

// Message Schema
const actionMessageSchema = z.object({
  actionId: z.string().optional(),
  senderAccountId: z.string().optional(),
  message: z.string().min(1),
});

// Create Action
const create_action = z.object({
  inspectionId: z.string().min(1),

  siteId: z.string().optional(),
  questionId: z.string().optional(),

  actionTitle: z.string().min(1).max(255),
  actionDisc: z.string().min(1),

  priority: PRIORITY_ENUM,

  dueDate: z.coerce.date(),

  status: STATUS_ENUM.optional().default('TO_DO'),

  // File URLs returned by POST /action/attachment (uploaded separately,
  // then attached to the action by URL — same two-step pattern as
  // inspection's upload-file-aws flow). Restricted to http(s) URLs and
  // capped in count/length: this field is set directly by the client, not
  // just via the upload endpoint, so it's a real input-validation boundary —
  // an unrestricted array of unrestricted strings would allow a
  // javascript:/data: URI stored wherever attachments are later rendered as
  // links or images, plus an unbounded per-row storage footprint. Found by
  // independent review.
  attachments: z.array(httpUrl).max(10).optional(),

  // "Assigned Responsible" — a plain informational tag, not access control
  // (see ActionResponsible's own schema comment for why this is a separate
  // model from FindingAssignment). OrgMember ids, not Account ids —
  // confirmed against what aexa-frontend's CreateNewFindingModal.tsx
  // actually submits. Capped in count for the same reason attachments is:
  // client-set field, real input-validation boundary. Rejected here (not
  // silently deduped) if the same id appears twice — ActionResponsible has
  // a DB-level @@unique([actionId, orgMemberId]), so a duplicate would
  // otherwise reach Prisma as an unhandled unique-constraint error instead
  // of a clean 4xx. Found by independent review.
  assignBy: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .refine((ids) => !ids || new Set(ids).size === ids.length, {
      message: 'assignBy contains duplicate ids',
    }),

  // relation
  messages: z.array(actionMessageSchema).optional(),
});

// Update Action
const update_action = create_action.partial();

// Slice 4 (#55): sub-assign a finding to an internal Light User member.
// Slice 5 extends this to an external Light User via externalOrgMemberId —
// exactly one of the two must be present, never both/neither, since a
// FindingAssignment row is one or the other (see the model's own schema
// comment on its two partial unique indexes).
const assign_light_user = z
  .object({
    orgMemberId: z.string().min(1).optional(),
    externalOrgMemberId: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.orgMemberId) !== Boolean(data.externalOrgMemberId), {
    message: 'Provide exactly one of orgMemberId or externalOrgMemberId.',
  });

// Types
export type ActionInput = z.infer<typeof create_action>;
export type ActionMessageInput = z.infer<typeof actionMessageSchema>;

// Export
export const action_validations = {
  create_action,
  update_action,
  actionMessageSchema,
  assign_light_user,
};
