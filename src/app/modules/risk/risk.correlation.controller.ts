import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { risk_correlation_service } from './risk.correlation.service.js';

const get_correlation_matrix = catchAsync(async (req, res) => {
  const result = await risk_correlation_service.get_correlation_matrix_data(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Correlation matrix data fetched successfully.',
    data: result,
    meta: {},
  });
});

const root_cause_bucketing = catchAsync(async (req, res) => {
  const result = await risk_correlation_service.run_root_cause_bucketing(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Root-cause bucketing completed successfully.',
    data: result,
    meta: {},
  });
});

const create_action_from_bucket = catchAsync(async (req, res) => {
  const result = await risk_correlation_service.create_action_from_bucket(req);
  manageResponse(res, {
    success: true,
    statusCode: 201,
    message: 'Action created from root-cause bucket successfully.',
    data: result,
    meta: {},
  });
});

export const risk_correlation_controller = {
  get_correlation_matrix,
  root_cause_bucketing,
  create_action_from_bucket,
};
