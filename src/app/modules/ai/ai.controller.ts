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
const generate_recommendation_with_inspection = catchAsync(async (req, res) => {
  const result = await ai_service.generate_recommendation_with_inspection_from_ai(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Recommendation generated successfully.',
    data: result,
    meta: {},
  });
});
const analyze_site_risks = catchAsync(async (req, res) => {
  const result = await ai_service.analyze_site_risks_with_ai(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Site risk analysis generated successfully.',
    data: result,
    meta: {},
  });
});
const upload_pdf_into_pinecone = catchAsync(async (req, res) => {
  const result = await ai_service.upload_pdf_into_pinecone_via_ai(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'PDF uploaded successfully.',
    data: result,
    meta: {},
  });
});
const check_upload_file_status = catchAsync(async (req, res) => {
  const result = await ai_service.check_upload_file_status_from_ai(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Upload status fetched successfully.',
    data: result,
    meta: {},
  });
});
const get_all_pinecone_data = catchAsync(async (req, res) => {
  const result = await ai_service.get_all_pinecone_data_from_database(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Pinecone data fetched successfully.',
    data: result,
    meta: {},
  });
});
const delete_pinecone_data = catchAsync(async (req, res) => {
  const result = await ai_service.delete_pinecone_data_from_database(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Pinecone data deleted successfully.',
    data: result,
    meta: {},
  });
});

export const ai_controller = {
  generate_template_with_prompt,
  generate_template_with_pdf,
  generate_template_with_risk,
  generate_recommendation_with_inspection,
  analyze_site_risks,
  upload_pdf_into_pinecone,
  check_upload_file_status,
  get_all_pinecone_data,
  delete_pinecone_data,
};
