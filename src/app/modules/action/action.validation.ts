import { z } from 'zod';

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
