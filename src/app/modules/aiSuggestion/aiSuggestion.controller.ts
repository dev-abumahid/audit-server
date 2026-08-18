import catchAsync from '../../utils/catch_async.js';
import manageResponse from '../../utils/manage_response.js';
import { ai_suggestion_service } from './aiSuggestion.service.js';

const dismiss_suggestion = catchAsync(async (req, res) => {
  const result = await ai_suggestion_service.dismiss_suggestion(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Suggestion dismissed successfully.',
    data: result,
    meta: {},
  });
});

const mark_suggestion_imported = catchAsync(async (req, res) => {
  const result = await ai_suggestion_service.mark_suggestion_imported(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Suggestion marked imported successfully.',
    data: result,
    meta: {},
  });
});

const get_site_suggestion_states = catchAsync(async (req, res) => {
  const result = await ai_suggestion_service.get_site_suggestion_states(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: 'Suggestion states fetched successfully.',
    data: result,
    meta: {},
  });
});

export const ai_suggestion_controller = {
  dismiss_suggestion,
  mark_suggestion_imported,
  get_site_suggestion_states,
};
