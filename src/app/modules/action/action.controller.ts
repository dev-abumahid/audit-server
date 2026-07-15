import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { action_service } from './action.service.js';

const get_all_action = catchAsync(async (req, res) => {
  const result = await action_service.get_all_action_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All action fetched successfully.',
    data: result.data,
    meta: result.meta,
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

const assign_light_user = catchAsync(async (req, res) => {
  const result = await action_service.assign_light_user_to_action(req);
  manageResponse(res, {
    success: true,
    statusCode: 201,
    message: 'Light User sub-assigned to finding successfully.',
    data: result,
    meta: {},
  });
});

const unassign_light_user = catchAsync(async (req, res) => {
  const result = await action_service.unassign_light_user_from_action(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Light User unassigned from finding successfully.',
    data: result,
    meta: {},
  });
});

const unassign_external_light_user = catchAsync(async (req, res) => {
  const result = await action_service.unassign_external_light_user_from_action(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'External Light User unassigned from finding successfully.',
    data: result,
    meta: {},
  });
});

const get_finding_assignments = catchAsync(async (req, res) => {
  const result = await action_service.get_finding_assignments_for_action(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Finding assignments fetched successfully.',
    data: result,
    meta: {},
  });
});

const get_my_finding_assignments = catchAsync(async (req, res) => {
  const result = await action_service.get_my_finding_assignments(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Your finding assignments fetched successfully.',
    data: result,
    meta: {},
  });
});

const approve_finding_assignment = catchAsync(async (req, res) => {
  const result = await action_service.approve_finding_assignment(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Finding assignment approved successfully.',
    data: result,
    meta: {},
  });
});

const reject_finding_assignment = catchAsync(async (req, res) => {
  const result = await action_service.reject_finding_assignment(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Finding assignment rejected successfully.',
    data: result,
    meta: {},
  });
});

const get_my_finding_assignments_external = catchAsync(async (req, res) => {
  const result = await action_service.get_my_finding_assignments_external(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Your finding assignments fetched successfully.',
    data: result,
    meta: {},
  });
});

const get_single_action_external = catchAsync(async (req, res) => {
  const result = await action_service.get_single_action_for_external_member(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Single action fetched successfully.',
    data: result,
    meta: {},
  });
});

const update_action_external = catchAsync(async (req, res) => {
  const result = await action_service.update_action_for_external_member(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'action updated successfully.',
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
  assign_light_user,
  unassign_light_user,
  unassign_external_light_user,
  get_finding_assignments,
  get_my_finding_assignments,
  approve_finding_assignment,
  reject_finding_assignment,
  get_my_finding_assignments_external,
  get_single_action_external,
  update_action_external,
};
