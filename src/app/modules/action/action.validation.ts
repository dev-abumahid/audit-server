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

// Types
export type ActionInput = z.infer<typeof create_action>;
export type ActionMessageInput = z.infer<typeof actionMessageSchema>;

// Export
export const action_validations = {
  create_action,
  update_action,
  actionMessageSchema,
};
