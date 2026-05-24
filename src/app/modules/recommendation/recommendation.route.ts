
import { Router } from "express";
import auth from "../../middlewares/auth.js";
import RequestValidator from "../../middlewares/request_validator.js";
import { recommendation_controller } from "./recommendation.controller.js";
import { recommendation_validations } from "./recommendation.validation.js";

const router = Router();

router.get("/inspection/:inspectionId", auth("ORGANIZATION"), recommendation_controller.get_recommendation_by_inspectionId);
router.get("/", auth("ORGANIZATION"), recommendation_controller.get_all_recommendation);

router.get("/:id", auth("ORGANIZATION"), recommendation_controller.get_single_recommendation);
router.patch(
  "/update-question/:recQuestionId", auth("ORGANIZATION"),
  RequestValidator(recommendation_validations.update_recommendation_question),
  recommendation_controller.update_recommendation_answer,
);
router.patch(
  "/update-summary/:recommendationId", auth("ORGANIZATION"),
  RequestValidator(recommendation_validations.update_recommendation_summary),
  recommendation_controller.update_recommendation_summary,
);
router.delete("/:id", auth("ORGANIZATION"), recommendation_controller.delete_recommendation);

export default router;
