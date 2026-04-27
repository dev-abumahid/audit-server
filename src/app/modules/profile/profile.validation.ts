import { z } from 'zod';
const update_profile = z.object({
  fullName: z.string().optional(),
});

export const profile_validations = {
  update_profile,
};
