import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { report_service } from './report.service.js';

const get_all_report = catchAsync(async (req, res) => {
  const result = await report_service.get_all_report_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All reports fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const get_single_report = catchAsync(async (req, res) => {
  const result = await report_service.get_single_report_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Single report fetched successfully.',
    data: result,
    meta: {},
  });
});

const generate_report = catchAsync(async (req, res) => {
  const result = await report_service.generate_report_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Report generated successfully.',
    data: result,
    meta: {},
  });
});

const download_report = catchAsync(async (req, res) => {
  const result = await report_service.download_report_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Report download URL fetched successfully.',
    data: result,
    meta: {},
  });
});

const publish_report = catchAsync(async (req, res) => {
  const result = await report_service.publish_report_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Report published successfully.',
    data: result,
    meta: {},
  });
});

export const report_controller = {
  get_all_report,
  get_single_report,
  generate_report,
  download_report,
  publish_report,
};
