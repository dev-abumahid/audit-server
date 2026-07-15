import { configs } from '../../configs/index.js';
import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { external_auth_services } from './external-auth.service.js';

const request_code = catchAsync(async (req, res) => {
  const result = await external_auth_services.request_verification_code_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: result.message,
    data: {},
    meta: {},
  });
});

const verify_code = catchAsync(async (req, res) => {
  const { accessToken, ...returnPayload } = await external_auth_services.verify_code_and_login(req);

  res.cookie('external_access_token', accessToken, {
    secure: configs.env === 'production',
    httpOnly: true,
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  });

  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Login successful.',
    data: { accessToken, ...returnPayload },
    meta: {},
  });
});

export const external_auth_controller = {
  request_code,
  verify_code,
};
