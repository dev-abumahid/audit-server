import { logger } from '../../../lib/logger.js';
import { resetPasswordEmailTemplate } from '../../../templates/resetPasswordEmailTemplate.js';
import sendMail from '../../../utils/mail_sender.js';
import { TResetEmailQueue } from './reset.email.queue.js';

export const resetEmailProcessor = async (job: any) => {
  const payload: TResetEmailQueue = job.data;
  await sendMail({
    to: payload.email as string,
    subject: 'Reset Your Password',
    htmlBody: resetPasswordEmailTemplate(payload.resetLink),
    textBody: 'Reset Your Password',
  });
  logger.info(`Reset Password Link Send successfully on : ${payload.email}`);
};
