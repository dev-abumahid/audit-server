import { logger } from '../../../lib/logger.js';
import { orgInviteEmailTemplate } from '../../../templates/orgInviteEmailTemplate.js';
import sendMail from '../../../utils/mail_sender.js';
import { TOrgInviteEmailQueue } from './org-invite.email.queue.js';

export const orgInviteEmailProcessor = async (job: any) => {
  const payload: TOrgInviteEmailQueue = job.data;
  await sendMail({
    to: payload.email as string,
    subject: `You've been invited to join ${payload.organizationName}`,
    htmlBody: orgInviteEmailTemplate(payload),
    textBody: `You've been invited to join ${payload.organizationName}. Accept your invite: ${payload.inviteLink}`,
  });
  logger.info(`Org invite email sent successfully to: ${payload.email}`);
};
