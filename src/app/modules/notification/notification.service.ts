import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';

// Called by aexa-ai's send_notification() webhook (upload_pdf_to_pinecone.py)
// when async PDF-to-Pinecone processing finishes (success or failure) — see
// #96. No end-user session involved (verified via verify_ai_internal_secret
// at the route level instead), so there's no req.user / resolveCallerOrgContext
// here the way every other write in this codebase has.
const create_notification_from_webhook_into_db = async (req: Request) => {
  const { orgUserName, notificationTitle, notificationDescription, status } = req.body;

  // orgUserName is actually an Account id (see notification.validation.ts) —
  // confirmed to exist before inserting, rather than letting an unknown id
  // surface as an opaque Prisma FK-constraint error.
  const account = await prisma.account.findUnique({ where: { id: orgUserName } });
  if (!account) {
    throw new AppError('Unknown organization for this notification.', 404);
  }

  const result = await prisma.notification.create({
    data: {
      orgAccountId: orgUserName,
      title: notificationTitle,
      description: notificationDescription,
      status,
    },
  });

  return result;
};

export const notification_service = {
  create_notification_from_webhook_into_db,
};
