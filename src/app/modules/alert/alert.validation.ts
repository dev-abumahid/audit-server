import { z } from 'zod';

const create_alert = z.object({
  source: z.string().min(1, 'Source is required'),
  type: z.string().min(1, 'Type is required'),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  kri_id: z.string().optional(),
});

const mark_read = z.object({
  is_read: z.boolean(),
});

export const alert_validations = {
  create_alert,
  mark_read,
};
