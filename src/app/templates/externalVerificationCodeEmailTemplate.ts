import { TExternalVerificationEmailQueue } from '../queues/email/external-verification/external-verification.email.queue.js';
import { escapeHtml } from '../utils/escape_html.js';

export const externalVerificationCodeEmailTemplate = (payload: TExternalVerificationEmailQueue) => {
  // organizationName is free-text (Organization.name) and code is a
  // server-generated numeric string (see otpGenerator.ts's
  // numericVerificationCodeGenerator), but both land in an HTML email —
  // escape defensively rather than assume the numeric generator can never
  // change shape.
  const organizationName = escapeHtml(payload.organizationName);
  const code = escapeHtml(payload.code);
  return `
    <!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Your access code</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: Arial, Helvetica, sans-serif;
            background-color: #f1f5f9;
            color: #1e2937;
            line-height: 1.6;
        }
        .container {
            max-width: 600px;
            margin: 30px auto;
            background: #ffffff;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 20px rgba(0,0,0,0.08);
        }
        .header {
            background: linear-gradient(135deg, #4f46e5, #6366f1);
            padding: 45px 30px;
            text-align: center;
            color: white;
        }
        .content {
            padding: 45px 35px;
            text-align: center;
        }
        .title {
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 12px;
            color: #1e2937;
        }
        .message {
            font-size: 16px;
            color: #475569;
            margin-bottom: 25px;
        }
        .code {
            display: inline-block;
            font-size: 36px;
            font-weight: 700;
            letter-spacing: 10px;
            color: #4f46e5;
            background: #eef2ff;
            padding: 18px 30px;
            border-radius: 10px;
            margin: 10px 0 30px 0;
        }
        .footer {
            background: linear-gradient(135deg, #4f46e5, #6366f1);
            padding: 45px 30px;
            text-align: center;
            color: white;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="font-size: 28px; margin: 0;">Your access code</h1>
        </div>
        <div class="content">
            <p class="title">Hello,</p>
            <p class="message">
                Use this code to access <strong>${organizationName}</strong>. It expires in 10 minutes.
            </p>
            <div class="code">${code}</div>
            <div style="background: #fef3c7; color: #92400e; padding: 16px 20px; border-radius: 8px; font-size: 14px; margin: 15px 0; text-align: left;">
                <strong>Note:</strong> If you didn't request this code, you can safely ignore this email.
            </div>
        </div>
        <div class="footer">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                    <td align="center">
                        <img src="https://i.ibb.co.com/TnKvMyg/democompany.png"
                             style="width: 75px; height: 75px; border-radius: 50%; display: block; margin: 0 auto 15px auto;"
                             alt="Company Logo">
                        <h3 style="color: #ffffff; font-size: 24px; margin: 0 0 8px 0;">Company Name</h3>
                        <p style="color: #ffffff; margin: 0 0 25px 0; opacity: 0.95;">The Support Team</p>
                        <p style="color: #ffffff; font-size: 13.5px; line-height: 1.5; opacity: 0.92;">
                            This is an automated message — please do not reply to this email.<br>
                            If you need help, feel free to contact our support.
                        </p>
                    </td>
                </tr>
            </table>
        </div>
    </div>
</body>
</html>
    `;
};
