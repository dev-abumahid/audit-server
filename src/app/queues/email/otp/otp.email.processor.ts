import { logger } from '../../../lib/logger.js';
import { otpEmailTemplate } from '../../../templates/otpEmailTemplate.js';
import sendMail from '../../../utils/mail_sender.js';
import { TOtpEmailQueue } from './otp.email.queue.js';

export const emailProcessor = async (job: any) => {
  const payload: TOtpEmailQueue = job.data;
  await sendMail({
    to: payload.email as string,
    subject: 'Verify Your Email',
    htmlBody: otpEmailTemplate(payload),
    textBody: 'Verify Your Email',
  });
  logger.info(`OTP Send successfully on : ${payload.email}`);
};
