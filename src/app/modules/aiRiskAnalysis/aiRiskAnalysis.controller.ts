import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { ai_risk_analysis_service } from './aiRiskAnalysis.service.js';

const start_ai_risk_analysis = catchAsync(async (req, res) => {
  const result = await ai_risk_analysis_service.start_ai_risk_analysis(req);
  manageResponse(res, {
    success: true,
    statusCode: 202,
    message: 'AI risk analysis started.',
    data: result,
    meta: {},
  });
});

const get_ai_risk_analysis_run = catchAsync(async (req, res) => {
  const result = await ai_risk_analysis_service.get_ai_risk_analysis_run(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'AI risk analysis run fetched successfully.',
    data: result,
    meta: {},
  });
});

export const ai_risk_analysis_controller = {
  start_ai_risk_analysis,
  get_ai_risk_analysis_run,
};
