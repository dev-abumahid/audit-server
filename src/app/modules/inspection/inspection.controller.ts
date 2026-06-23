import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { inspection_service } from './inspection.service.js';

const get_all_inspection = catchAsync(async (req, res) => {
  const result = await inspection_service.get_all_inspection_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All inspection fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const get_single_inspection = catchAsync(async (req, res) => {
  const result = await inspection_service.get_single_inspection_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Single inspection fetched successfully.',
    data: result,
    meta: {},
  });
});

const create_inspection = catchAsync(async (req, res) => {
  const result = await inspection_service.create_inspection_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'inspection created successfully.',
    data: result,
    meta: {},
  });
});

const update_inspection = catchAsync(async (req, res) => {
  const result = await inspection_service.update_inspection_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'inspection updated successfully.',
    data: result,
    meta: {},
  });
});

const delete_inspection = catchAsync(async (req, res) => {
  const result = await inspection_service.delete_inspection_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'inspection deleted successfully.',
    data: result,
    meta: {},
  });
});
const update_inspection_question = catchAsync(async (req, res) => {
  const result = await inspection_service.update_inspection_question_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'inspection question updated successfully.',
    data: result,
    meta: {},
  });
});
const upload_any_file_into_aws = catchAsync(async (req, res) => {
  const result = await inspection_service.upload_any_file_into_aws_for_inspection(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'File upload successful',
    data: result,
    meta: {},
  });
});
const split_note_into_inspection = catchAsync(async (req, res) => {
  const result = await inspection_service.split_note_into_inspection_using_ai(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Note split into inspection successfully.',
    data: result,
    meta: {},
  });
});

export const inspection_controller = {
  get_all_inspection,
  get_single_inspection,
  create_inspection,
  update_inspection,
  delete_inspection,
  update_inspection_question,
  upload_any_file_into_aws,
  split_note_into_inspection,
};
