import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { governance_service } from './governance.service.js';

const get_three_lines_of_defense = catchAsync(async (req, res) => {
  const result = await governance_service.get_three_lines_of_defense_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Three lines of defense classification fetched successfully.',
    data: result,
    meta: {},
  });
});

export const governance_controller = {
  get_three_lines_of_defense,
};
