import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { template_service } from './template.service.js';

const get_all_template = catchAsync(async (req, res) => {
  const result = await template_service.get_all_template_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All template fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const get_single_template = catchAsync(async (req, res) => {
  const result = await template_service.get_single_template_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Single template fetched successfully.',
    data: result,
    meta: {},
  });
});

const create_template = catchAsync(async (req, res) => {
  const result = await template_service.create_template_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'template created successfully.',
    data: result,
    meta: {},
  });
});

const update_template = catchAsync(async (req, res) => {
  const result = await template_service.update_template_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'template updated successfully.',
    data: result,
    meta: {},
  });
});

const delete_template = catchAsync(async (req, res) => {
  const result = await template_service.delete_template_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'template deleted successfully.',
    data: result,
    meta: {},
  });
});

// part by part update

const update_or_create_new_page = catchAsync(async (req, res) => {
  const result = await template_service.update_or_create_new_page_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Page updated or created successfully.',
    data: result,
    meta: {},
  });
});
const delete_template_page_by_id = catchAsync(async (req, res) => {
  const result = await template_service.delete_template_page_by_id_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Page deleted successfully.',
    data: result,
    meta: {},
  });
});
const update_or_delete_new_question = catchAsync(async (req, res) => {
  const result = await template_service.update_or_delete_new_question_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Question updated or deleted successfully.',
    data: result,
    meta: {},
  });
});
const delete_page_question_by_id = catchAsync(async (req, res) => {
  const result = await template_service.delete_page_question_by_id_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Question deleted successfully.',
    data: result,
    meta: {},
  });
});

export const template_controller = {
  get_all_template,
  get_single_template,
  create_template,
  update_template,
  delete_template,
  update_or_create_new_page,
  delete_template_page_by_id,
  update_or_delete_new_question,
  delete_page_question_by_id,
};
