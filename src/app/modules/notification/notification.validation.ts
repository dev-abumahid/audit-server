import { z } from 'zod';

// Field names match aexa-ai's send_notification() payload verbatim
// (upload_pdf_to_pinecone.py) — orgUserName is actually an Account id
// (aexa-server passes ctx.organizationId as organization_username when it
// calls aexa-ai's /upload-pdf-to-pinecone in the first place), not a
// username in the aexa-server sense.
const create_notification_from_webhook = z.object({
  orgUserName: z.string().min(1),
  notificationTitle: z.string().min(1),
  notificationDescription: z.string().min(1),
  status: z.boolean(),
});

export const notification_validations = {
  create_notification_from_webhook,
};
