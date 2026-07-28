import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { risk_link_service } from './risk_link.service.js';

const create_risk_link = catchAsync(async (req, res) => {
  const result = await risk_link_service.create_risk_link_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Risk link created successfully.',
    data: result,
    meta: {},
  });
});

const get_all_risk_links = catchAsync(async (req, res) => {
  // aexa-server#271: get_all_risk_links_from_db now returns {data, meta}
  // (was a bare array) -- forward both, matching note_controller/
  // recommendation_controller's identical pattern. Passing the whole
  // result as `data` would double-nest it (data: {data, meta}) and always
  // send an empty meta, losing the pagination info entirely.
  const result = await risk_link_service.get_all_risk_links_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All risk links fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const delete_risk_link = catchAsync(async (req, res) => {
  const result = await risk_link_service.delete_risk_link_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Risk link deleted successfully.',
    data: result,
    meta: {},
  });
});

export const risk_link_controller = {
  create_risk_link,
  get_all_risk_links,
  delete_risk_link,
};
