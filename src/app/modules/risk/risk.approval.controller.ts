import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { risk_approval_service } from './risk.approval.service.js';

const submit_risk_for_approval = catchAsync(async (req, res) => {
  const result = await risk_approval_service.submit_risk_for_approval(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Risk submitted for approval.',
    data: result,
    meta: {},
  });
});

const approve_risk = catchAsync(async (req, res) => {
  const result = await risk_approval_service.approve_risk(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Risk approval approved.',
    data: result,
    meta: {},
  });
});

const reject_risk = catchAsync(async (req, res) => {
  const result = await risk_approval_service.reject_risk(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Risk approval rejected.',
    data: result,
    meta: {},
  });
});

const get_risk_approval_state = catchAsync(async (req, res) => {
  const result = await risk_approval_service.get_risk_approval_state(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Risk approval state fetched successfully.',
    data: result,
    meta: {},
  });
});

export const risk_approval_controller = {
  submit_risk_for_approval,
  approve_risk,
  reject_risk,
  get_risk_approval_state,
};
