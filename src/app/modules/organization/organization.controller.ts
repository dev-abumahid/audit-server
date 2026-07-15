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

const get_org_members = catchAsync(async (req, res) => {
  const result = await organization_services.get_org_members_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Organization members fetched successfully.',
    data: result,
    meta: {},
  });
});

const update_org_member = catchAsync(async (req, res) => {
  const result = await organization_services.update_org_member_in_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Organization member updated successfully.',
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

const get_organization_settings = catchAsync(async (req, res) => {
  const result = await organization_services.get_organization_settings_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Organization settings fetched successfully.',
    data: result,
    meta: {},
  });
});

const update_organization_settings = catchAsync(async (req, res) => {
  const result = await organization_services.update_organization_settings_in_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Organization settings updated successfully.',
    data: result,
    meta: {},
  });
});

const invite_external_member = catchAsync(async (req, res) => {
  const result = await organization_services.invite_external_member_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 201,
    message: 'External member invited successfully.',
    data: result,
    meta: {},
  });
});

const get_external_members = catchAsync(async (req, res) => {
  const result = await organization_services.get_external_members_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'External members fetched successfully.',
    data: result,
    meta: {},
  });
});

const update_external_member = catchAsync(async (req, res) => {
  const result = await organization_services.update_external_member_in_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'External member updated successfully.',
    data: result,
    meta: {},
  });
});

export const organization_controller = {
  invite_member,
  get_pending_invitations,
  get_org_members,
  update_org_member,
  resend_invitation,
  accept_invitation,
  get_organization_settings,
  update_organization_settings,
  invite_external_member,
  get_external_members,
  update_external_member,
};
