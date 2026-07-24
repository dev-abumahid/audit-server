import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { onboarding_service } from './onboarding.service.js';

const identify = catchAsync(async (req, res) => {
  const result = await onboarding_service.identify_company(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Company profile identified successfully.',
    data: result,
    meta: {},
  });
});

const generate = catchAsync(async (req, res) => {
  const result = await onboarding_service.generate_baseline(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Onboarding baseline generated successfully.',
    data: result,
    meta: {},
  });
});

const commit = catchAsync(async (req, res) => {
  const result = await onboarding_service.commit_onboarding(req);
  manageResponse(res, {
    success: true,
    statusCode: 201,
    message: 'Organization created successfully.',
    data: result,
    meta: {},
  });
});

export const onboarding_controller = {
  identify,
  generate,
  commit,
};
