import { z } from 'zod';

const create_note = z.object({
  title: z.string(),
  extracted_text: z.string(),
  inspectionId: z.string(),
});
const update_note = z.object({
  title: z.string().optional(),
  extracted_text: z.string().optional(),
});
const from_file = z.object({
  inspectionId: z.string(),
});
export const note_validations = {
  create_note,
  update_note,
  from_file,
};
