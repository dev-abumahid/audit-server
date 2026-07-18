import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { notification_service } from './notification.service.js';

const create_notification_from_webhook = catchAsync(async (req, res) => {
  const result = await notification_service.create_notification_from_webhook_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Notification recorded successfully',
    data: result,
  });
});

export const notification_controller = {
  create_notification_from_webhook,
};
