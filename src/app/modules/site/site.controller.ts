import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { site_service } from './site.service.js';

const get_all_site = catchAsync(async (req, res) => {
  const result = await site_service.get_all_site_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All site fetched successfully.',
    data: result,
    meta: {},
  });
});

const get_single_site = catchAsync(async (req, res) => {
  const result = await site_service.get_single_site_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Single site fetched successfully.',
    data: result,
    meta: {},
  });
});

const create_site = catchAsync(async (req, res) => {
  const result = await site_service.create_site_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'site created successfully.',
    data: result,
    meta: {},
  });
});

const update_site = catchAsync(async (req, res) => {
  const result = await site_service.update_site_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'site updated successfully.',
    data: result,
    meta: {},
  });
});

const delete_site = catchAsync(async (req, res) => {
  const result = await site_service.delete_site_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'site deleted successfully.',
    data: result,
    meta: {},
  });
});

export const site_controller = {
  get_all_site,
  get_single_site,
  create_site,
  update_site,
  delete_site,
};
