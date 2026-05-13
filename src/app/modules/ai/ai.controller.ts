import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { ai_service } from './ai.service.js';

const generate_template_with_prompt = catchAsync(async (req, res) => {
  const result = await ai_service.generate_template_with_prompt_with_ai(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Template generated successfully.',
    data: result,
    meta: {},
  });
});
const generate_template_with_pdf = catchAsync(async (req, res) => {
  const result = await ai_service.generate_template_with_pdf_with_ai(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Template generated successfully.',
    data: result,
    meta: {},
  });
});
const generate_template_with_risk = catchAsync(async (req, res) => {
  const result = await ai_service.generate_template_with_risk_with_ai(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Template generated successfully.',
    data: result,
    meta: {},
  });
});

export const ai_controller = {
  generate_template_with_prompt,
  generate_template_with_pdf,
  generate_template_with_risk,
};
