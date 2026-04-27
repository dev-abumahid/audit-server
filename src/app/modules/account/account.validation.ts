import z from 'zod';

const sign_up = z.object({
  email: z.string('Email is required.'),
  password: z.string('Password is required.'),
  organizationName: z.string('Full name is required.'),
});

const sing_in = z.object({
  email: z.string('Email is required.'),
  password: z.string('Password is required.'),
});

const change_password = z.object({
  oldPassword: z.string('Old Password is required'),
  newPassword: z.string('New Password is required'),
});

const verify_otp = z.object({
  email: z.string('Email is required'),
  otp: z.string('OTP is required'),
});
const verify_link = z.object({
  token: z.string('Token is required '),
});
const resend_otp = z.object({
  email: z.string('Email is required'),
});
const reset_pass = z.object({
  token: z.string('Token is required'),
  newPass: z.string('Password is required'),
});
export const account_validation = {
  sign_up,
  sing_in,
  change_password,
  verify_otp,
  resend_otp,
  verify_link,
  reset_pass,
};
