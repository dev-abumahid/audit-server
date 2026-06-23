import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { note_service } from './note.service.js';

const get_all_note = catchAsync(async (req, res) => {
  const result = await note_service.get_all_note_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All note fetched successfully.',
    data: result,
    meta: {},
  });
});

const get_single_note = catchAsync(async (req, res) => {
  const result = await note_service.get_single_note_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Single note fetched successfully.',
    data: result,
    meta: {},
  });
});
const get_note_by_inspection_id = catchAsync(async (req, res) => {
  const result = await note_service.get_note_by_inspection_id_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Note fetched successfully by inspection id.',
    data: result,
    meta: {},
  });
});

const save_raw_note = catchAsync(async (req, res) => {
  const result = await note_service.save_raw_note_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'note saved successfully.',
    data: result,
    meta: {},
  });
});
const extract_note_from_any_file_or_image = catchAsync(async (req, res) => {
  const result = await note_service.extract_note_from_any_file_or_image_and_save_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'note extracted successfully.',
    data: result,
    meta: {},
  });
});

const update_note = catchAsync(async (req, res) => {
  const result = await note_service.update_note_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'note updated successfully.',
    data: result,
    meta: {},
  });
});

const delete_note = catchAsync(async (req, res) => {
  const result = await note_service.delete_note_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'note deleted successfully.',
    data: result,
    meta: {},
  });
});

export const note_controller = {
  get_all_note,
  get_single_note,
  save_raw_note,
  update_note,
  delete_note,
  extract_note_from_any_file_or_image,
  get_note_by_inspection_id,
};
