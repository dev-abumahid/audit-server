import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { action_service } from './action.service.js';

const get_all_action = catchAsync(async (req, res) => {
  const result = await action_service.get_all_action_from_db();
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All action fetched successfully.',
    data: result,
    meta: {},
  });
});

const get_single_action = catchAsync(async (req, res) => {
  const result = await action_service.get_single_action_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Single action fetched successfully.',
    data: result,
    meta: {},
  });
});

const create_action = catchAsync(async (req, res) => {
  const result = await action_service.create_action_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'action created successfully.',
    data: result,
    meta: {},
  });
});

const update_action = catchAsync(async (req, res) => {
  const result = await action_service.update_action_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'action updated successfully.',
    data: result,
    meta: {},
  });
});

const delete_action = catchAsync(async (req, res) => {
  const result = await action_service.delete_action_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'action deleted successfully.',
    data: result,
    meta: {},
  });
});

export const action_controller = {
  get_all_action,
  get_single_action,
  create_action,
  update_action,
  delete_action,
};
