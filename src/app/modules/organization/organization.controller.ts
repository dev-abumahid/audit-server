import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { organization_services } from './organization.service.js';

const invite_member = catchAsync(async (req, res) => {
  const result = await organization_services.invite_member_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 201,
    message: 'Invitation sent successfully.',
    data: result,
    meta: {},
  });
});

const get_pending_invitations = catchAsync(async (req, res) => {
  const result = await organization_services.get_pending_invitations_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Pending invitations fetched successfully.',
    data: result,
    meta: {},
  });
});

const resend_invitation = catchAsync(async (req, res) => {
  const result = await organization_services.resend_invitation_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Invitation resent successfully.',
    data: result,
    meta: {},
  });
});

const accept_invitation = catchAsync(async (req, res) => {
  const result = await organization_services.accept_invitation_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Invitation accepted successfully.',
    data: result,
    meta: {},
  });
});

export const organization_controller = {
  invite_member,
  get_pending_invitations,
  resend_invitation,
  accept_invitation,
};
