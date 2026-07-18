import { z } from 'zod';

// Same restriction as Action.attachments/Inspection.attachments and for the
// same reason: z.string().url() alone accepts javascript:/data: schemes, and
// this field is set directly by the client, not just via the upload flow.
const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'Attachment URL must be http(s)',
  });

const create_note = z.object({
  title: z.string(),
  extracted_text: z.string(),
  inspectionId: z.string(),
});
const update_note = z.object({
  title: z.string().optional(),
  extracted_text: z.string().optional(),
  // A text-typed note (save_raw_note) never has a source file, but a
  // file-extracted note's attachment (set by extract_note_from_any_file_or_
  // image_and_save_into_db) can still be cleared/replaced here — same
  // pattern as Action/Inspection's PATCH-to-set-attachments.
  attachments: z.array(httpUrl).max(10).optional(),
});
const from_file = z.object({
  inspectionId: z.string(),
});
export const note_validations = {
  create_note,
  update_note,
  from_file,
};
