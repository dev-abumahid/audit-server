import { configs } from '../../configs/index.js';
import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { account_services } from './account.service.js';

const create_account = catchAsync(async (req, res) => {
  const result = await account_services.create_account_into_db(req);
  manageResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Organization created successfully',
    data: result,
  });
});

const verify_account_using_otp = catchAsync(async (req, res) => {
  const result = await account_services.verify_account_using_otp_into_db(req);
  manageResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Otp verification successful',
    data: result,
  });
});

const verify_account_using_link = catchAsync(async (req, res) => {
  const result = await account_services.verify_account_using_link_into_db(req);
  manageResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Account verification successful',
    data: result,
  });
});

const login_user = catchAsync(async (req, res) => {
  const { accessToken, returnPayload } = await account_services.login_user_into_db(req);

  // set access token into cookie
  res.cookie('access_token', `Bearer ${accessToken}`, {
    secure: configs.env === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });

  manageResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Login successfully',
    data: returnPayload,
  });
});
const get_user_account = catchAsync(async (req, res) => {
  const result = await account_services.get_user_account_from_db(req);

  manageResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Account fetched successfully',
    data: result,
  });
});

const change_password = catchAsync(async (req, res) => {
  const result = await account_services.change_password_into_db(req);
  manageResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Password Change successfully',
    data: result,
  });
});

const resend_otp_and_verification_link = catchAsync(async (req, res) => {
  const result = await account_services.resend_otp_and_verification_link_from_db(req);
  manageResponse(res, {
    statusCode: 200,
    success: true,
    message: 'OTP reset successfully',
    data: result,
  });
});

const forget_password_generate_reset_token = catchAsync(async (req, res) => {
  const result = await account_services.forget_password_generate_reset_token_from_db(req);
  manageResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Password reset successfully',
    data: result,
  });
});

const reset_password_using_token = catchAsync(async (req, res) => {
  const result = await account_services.reset_password_using_token_into_db(req);
  manageResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Password reset successfully',
    data: result,
  });
});

export const account_controller = {
  create_account,
  login_user,
  get_user_account,
  change_password,
  verify_account_using_otp,
  resend_otp_and_verification_link,
  verify_account_using_link,
  forget_password_generate_reset_token,
  reset_password_using_token,
};
