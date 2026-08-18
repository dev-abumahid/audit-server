import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { risk_service } from './risk.service.js';

const get_ebitda_at_risk_summary = catchAsync(async (req, res) => {
  const result = await risk_service.get_ebitda_at_risk_summary(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'EBITDA-at-risk summary fetched successfully.',
    data: result,
    meta: {},
  });
});

const get_all_risk = catchAsync(async (req, res) => {
  const result = await risk_service.get_all_risk_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All risk fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const get_single_risk = catchAsync(async (req, res) => {
  const result = await risk_service.get_single_risk_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Single risk fetched successfully.',
    data: result,
    meta: {},
  });
});

const create_risk = catchAsync(async (req, res) => {
  const result = await risk_service.create_risk_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'risk created successfully.',
    data: result,
    meta: {},
  });
});

const update_risk = catchAsync(async (req, res) => {
  const result = await risk_service.update_risk_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'risk updated successfully.',
    data: result,
    meta: {},
  });
});

const delete_risk = catchAsync(async (req, res) => {
  const result = await risk_service.delete_risk_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'risk deleted successfully.',
    data: result,
    meta: {},
  });
});

const suggest_fields = catchAsync(async (req, res) => {
  const result = await risk_service.suggest_risk_fields_with_ai(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Risk field suggestions generated successfully.',
    data: result,
    meta: {},
  });
});

export const risk_controller = {
  get_ebitda_at_risk_summary,
  get_all_risk,
  get_single_risk,
  create_risk,
  update_risk,
  delete_risk,
  suggest_fields,
};
