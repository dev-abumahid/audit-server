import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { alert_service } from './alert.service.js';

const get_all_alert = catchAsync(async (req, res) => {
  const result = await alert_service.get_all_alert_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All alerts fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const get_single_alert = catchAsync(async (req, res) => {
  const result = await alert_service.get_single_alert_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Single alert fetched successfully.',
    data: result,
    meta: {},
  });
});

const create_alert = catchAsync(async (req, res) => {
  const result = await alert_service.create_alert_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Alert created successfully.',
    data: result,
    meta: {},
  });
});

const mark_alert_read = catchAsync(async (req, res) => {
  const result = await alert_service.mark_alert_read_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Alert updated successfully.',
    data: result,
    meta: {},
  });
});

const delete_alert = catchAsync(async (req, res) => {
  const result = await alert_service.delete_alert_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Alert deleted successfully.',
    data: result,
    meta: {},
  });
});

export const alert_controller = {
  get_all_alert,
  get_single_alert,
  create_alert,
  mark_alert_read,
  delete_alert,
};
