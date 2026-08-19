import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { compliance_service } from './compliance.service.js';

const get_all_compliance = catchAsync(async (req, res) => {
  const result = await compliance_service.get_all_compliance_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'All compliance obligations fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const get_single_compliance = catchAsync(async (req, res) => {
  const result = await compliance_service.get_single_compliance_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Single compliance obligation fetched successfully.',
    data: result,
    meta: {},
  });
});

const create_compliance = catchAsync(async (req, res) => {
  const result = await compliance_service.create_compliance_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Compliance obligation created successfully.',
    data: result,
    meta: {},
  });
});

const update_compliance = catchAsync(async (req, res) => {
  const result = await compliance_service.update_compliance_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Compliance obligation updated successfully.',
    data: result,
    meta: {},
  });
});

const delete_compliance = catchAsync(async (req, res) => {
  const result = await compliance_service.delete_compliance_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Compliance obligation deleted successfully.',
    data: result,
    meta: {},
  });
});

const upload_compliance_attachment = catchAsync(async (req, res) => {
  const result = await compliance_service.upload_compliance_attachment_into_aws(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Attachment uploaded successfully.',
    data: result,
    meta: {},
  });
});

const get_compliance_scorecard = catchAsync(async (req, res) => {
  const result = await compliance_service.get_compliance_scorecard_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Compliance scorecard computed successfully.',
    data: result,
    meta: {},
  });
});

const attest_compliance = catchAsync(async (req, res) => {
  const result = await compliance_service.attest_compliance_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Compliance obligation re-attested successfully.',
    data: result,
    meta: {},
  });
});

const get_compliance_attestations = catchAsync(async (req, res) => {
  const result = await compliance_service.get_compliance_attestations_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Compliance attestation history fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const get_compliance_edit_history = catchAsync(async (req, res) => {
  const result = await compliance_service.get_compliance_edit_history_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Compliance edit history fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const create_risk_from_obligation = catchAsync(async (req, res) => {
  const result = await compliance_service.create_risk_from_obligation_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Risk created and linked to compliance obligation successfully.',
    data: result,
    meta: {},
  });
});

const link_risk_to_obligation = catchAsync(async (req, res) => {
  const result = await compliance_service.link_risk_to_obligation_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Compliance obligation linked to risk successfully.',
    data: result,
    meta: {},
  });
});

const unlink_risk_from_obligation = catchAsync(async (req, res) => {
  const result = await compliance_service.unlink_risk_from_obligation_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Compliance obligation unlinked from risk successfully.',
    data: result,
    meta: {},
  });
});

const suggest_regulatory_sources = catchAsync(async (req, res) => {
  const result = await compliance_service.suggest_regulatory_sources_with_ai(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Regulatory coverage suggestions generated successfully.',
    data: result,
    meta: {},
  });
});

export const compliance_controller = {
  get_all_compliance,
  get_single_compliance,
  create_compliance,
  update_compliance,
  delete_compliance,
  upload_compliance_attachment,
  get_compliance_scorecard,
  attest_compliance,
  get_compliance_attestations,
  get_compliance_edit_history,
  create_risk_from_obligation,
  link_risk_to_obligation,
  unlink_risk_from_obligation,
  suggest_regulatory_sources,
};
