
import catchAsync from "../../utils/catch_async";
import manageResponse from "../../utils/manage_response";
import { risk_service } from "./risk.service";

const get_all_risk = catchAsync(async (req, res) => {
  const result = await risk_service.get_all_risk_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: "All risk fetched successfully.",
    data: result,
    meta: {},
  });
});

const get_single_risk = catchAsync(async (req, res) => {
  const result = await risk_service.get_single_risk_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: "Single risk fetched successfully.",
    data: result,
    meta: {},
  });
});

const create_risk = catchAsync(async (req, res) => {
  const result = await risk_service.create_risk_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: "risk created successfully.",
    data: result,
    meta: {},
  });
});

const update_risk = catchAsync(async (req, res) => {
  const result = await risk_service.update_risk_into_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: "risk updated successfully.",
    data: result,
    meta: {},
  });
});

const delete_risk = catchAsync(async (req, res) => {
  const result = await risk_service.delete_risk_from_db(req);
  manageResponse(res, {
    success: true,
    statusCode: 200,
    message: "risk deleted successfully.",
    data: result,
    meta: {},
  });
});

export const risk_controller = {
  get_all_risk,
  get_single_risk,
  create_risk,
  update_risk,
  delete_risk,
};
    