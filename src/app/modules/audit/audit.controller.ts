import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { audit_service } from './audit.service.js';

const get_all_audit = catchAsync(async (req, res) => {
  const result = await audit_service.get_all_audit_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All audit engagements fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const get_single_audit = catchAsync(async (req, res) => {
  const result = await audit_service.get_single_audit_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Single audit engagement fetched successfully.',
    data: result,
    meta: {},
  });
});

const create_audit = catchAsync(async (req, res) => {
  const result = await audit_service.create_audit_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Audit engagement created successfully.',
    data: result,
    meta: {},
  });
});

const update_audit = catchAsync(async (req, res) => {
  const result = await audit_service.update_audit_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Audit engagement updated successfully.',
    data: result,
    meta: {},
  });
});

const delete_audit = catchAsync(async (req, res) => {
  const result = await audit_service.delete_audit_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Audit engagement deleted successfully.',
    data: result,
    meta: {},
  });
});

const upload_audit_report = catchAsync(async (req, res) => {
  const result = await audit_service.upload_audit_report_into_storage(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Report uploaded successfully.',
    data: result,
    meta: {},
  });
});

export const audit_controller = {
  get_all_audit,
  get_single_audit,
  create_audit,
  update_audit,
  delete_audit,
  upload_audit_report,
};
