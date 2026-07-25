import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { intelligence_service } from './intelligence.service.js';

const scrape_sources = catchAsync(async (req, res) => {
  const result = await intelligence_service.scrape_sources_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Threat intelligence sources scraped successfully.',
    data: result,
    meta: {},
  });
});

const analyze_items = catchAsync(async (req, res) => {
  const result = await intelligence_service.analyze_items_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Threat intelligence items analyzed successfully.',
    data: result,
    meta: {},
  });
});

const predict = catchAsync(async (req, res) => {
  const result = await intelligence_service.predict_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Threat prediction generated successfully.',
    data: result,
    meta: {},
  });
});

const generate_mitigations = catchAsync(async (req, res) => {
  const result = await intelligence_service.generate_mitigations_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Mitigations generated successfully.',
    data: result,
    meta: {},
  });
});

const generate_rcsa = catchAsync(async (req, res) => {
  const result = await intelligence_service.generate_rcsa_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'RCSA generated successfully.',
    data: result,
    meta: {},
  });
});

const resilience_scan = catchAsync(async (req, res) => {
  const result = await intelligence_service.resilience_scan_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Resilience scan generated successfully.',
    data: result,
    meta: {},
  });
});

const get_all_items = catchAsync(async (req, res) => {
  const result = await intelligence_service.get_all_items_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Threat intelligence items fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const get_all_runs = catchAsync(async (req, res) => {
  const result = await intelligence_service.get_all_runs_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Threat intelligence runs fetched successfully.',
    data: result.data,
    meta: result.meta,
  });
});

const create_risk_from_item = catchAsync(async (req, res) => {
  const result = await intelligence_service.create_risk_from_item_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Risk created from threat intelligence item successfully.',
    data: result,
    meta: {},
  });
});

export const intelligence_controller = {
  scrape_sources,
  analyze_items,
  predict,
  generate_mitigations,
  generate_rcsa,
  resilience_scan,
  get_all_items,
  get_all_runs,
  create_risk_from_item,
};
