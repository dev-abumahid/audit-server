
import { z } from "zod";

const create_inspection = z.object({});
const update_inspection = z.object({});

export const inspection_validations = {
  create_inspection,
  update_inspection,
};
