import { z } from 'zod';

// Field names match aexa-ai's notify_webhook() payload verbatim
// (upload_pdf_to_pinecone.py).
const upload_pdf_webhook = z.object({
  pdf_name: z.string().min(1),
  pdf_size: z.string().min(1),
});

export const knowledge_base_validations = {
  upload_pdf_webhook,
};
