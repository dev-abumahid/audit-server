
import catchAsync from "../../utils/catch_async.js";
import manageResponse from "../../utils/manage_response.js";
import { recommendation_service } from "./recommendation.service.js";

const get_all_recommendation = catchAsync(async (req, res) => {
  const result = await recommendation_service.get_all_recommendation_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: "All recommendation fetched successfully.",
    data: result,
    meta: {},
  });
});

const get_single_recommendation = catchAsync(async (req, res) => {
  const result = await recommendation_service.get_single_recommendation_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: "Single recommendation fetched successfully.",
    data: result,
    meta: {},
  });
});

const update_recommendation_answer = catchAsync(async (req, res) => {
  const result = await recommendation_service.update_recommendation_answer_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: "recommendation updated successfully.",
    data: result,
    meta: {},
  });
});

const delete_recommendation = catchAsync(async (req, res) => {
  const result = await recommendation_service.delete_recommendation_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: "recommendation deleted successfully.",
    data: result,
    meta: {},
  });
});
const get_recommendation_by_inspectionId = catchAsync(async (req, res) => {
  const result = await recommendation_service.get_recommendation_by_inspectionId_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: "Recommendation fetched successfully",
    data: result,
    meta: {},
  });
});

export const recommendation_controller = {
  get_all_recommendation,
  get_single_recommendation,
  update_recommendation_answer,
  delete_recommendation,
  get_recommendation_by_inspectionId
};
