import { logger } from '../../../lib/logger.js';
import { externalVerificationCodeEmailTemplate } from '../../../templates/externalVerificationCodeEmailTemplate.js';
import sendMail from '../../../utils/mail_sender.js';
import { TExternalVerificationEmailQueue } from './external-verification.email.queue.js';

export const externalVerificationEmailProcessor = async (job: any) => {
  const payload: TExternalVerificationEmailQueue = job.data;
  await sendMail({
    to: payload.email,
    subject: `Your access code for ${payload.organizationName}`,
    htmlBody: externalVerificationCodeEmailTemplate(payload),
    textBody: `Your access code for ${payload.organizationName} is ${payload.code}. It expires in 10 minutes.`,
  });
  logger.info(`External verification code email sent successfully to: ${payload.email}`);
};
