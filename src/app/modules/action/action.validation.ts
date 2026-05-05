import { z } from 'zod';

const create_action = z.object({});
const update_action = z.object({});

export const action_validations = {
  create_action,
  update_action,
};
