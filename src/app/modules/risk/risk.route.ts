
    import { Router } from "express";
import RequestValidator from "../../middlewares/request_validator";
import { risk_controller } from "./risk.controller";
import { risk_validations } from "./risk.validation";

const router = Router();

router.get("/", risk_controller.get_all_risk);
router.post(
  "/",
  RequestValidator(risk_validations.create_risk),
  risk_controller.create_risk,
);
router.get("/:id", risk_controller.get_single_risk);
router.patch(
  "/:id",
  RequestValidator(risk_validations.update_risk),
  risk_controller.update_risk,
);
router.delete("/:id", risk_controller.delete_risk);

export default router;
    