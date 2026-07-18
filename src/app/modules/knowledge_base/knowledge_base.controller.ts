import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { knowledge_base_service } from './knowledge_base.service.js';

const acknowledge_upload_pdf_webhook = catchAsync(async (req, res) => {
  const result = await knowledge_base_service.acknowledge_upload_pdf_webhook(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Webhook received',
    data: result,
  });
});

export const knowledge_base_controller = {
  acknowledge_upload_pdf_webhook,
};
