import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { kri_service } from './kri.service.js';

const get_all_kri = catchAsync(async (req, res) => {
  const result = await kri_service.get_all_kri_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All KRIs fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const get_single_kri = catchAsync(async (req, res) => {
  const result = await kri_service.get_single_kri_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Single KRI fetched successfully.',
    data: result,
    meta: {},
  });
});

const create_kri = catchAsync(async (req, res) => {
  const result = await kri_service.create_kri_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'KRI created successfully.',
    data: result,
    meta: {},
  });
});

const update_kri = catchAsync(async (req, res) => {
  const result = await kri_service.update_kri_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'KRI updated successfully.',
    data: result,
    meta: {},
  });
});

const submit_kri_value = catchAsync(async (req, res) => {
  const result = await kri_service.submit_kri_value_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'KRI value recorded successfully.',
    data: result,
    meta: {},
  });
});

const delete_kri = catchAsync(async (req, res) => {
  const result = await kri_service.delete_kri_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'KRI deleted successfully.',
    data: result,
    meta: {},
  });
});

export const kri_controller = {
  get_all_kri,
  get_single_kri,
  create_kri,
  update_kri,
  submit_kri_value,
  delete_kri,
};
