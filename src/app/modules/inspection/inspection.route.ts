
    import { Router } from "express";
import RequestValidator from "../../middlewares/request_validator.js";
import { inspection_controller } from "./inspection.controller.js";
import { inspection_validations } from "./inspection.validation.js";

const router = Router();

router.get("/", inspection_controller.get_all_inspection);
router.post(
  "/",
  RequestValidator(inspection_validations.create_inspection),
  inspection_controller.create_inspection,
);
router.get("/:id", inspection_controller.get_single_inspection);
router.patch(
  "/:id",
  RequestValidator(inspection_validations.update_inspection),
  inspection_controller.update_inspection,
);
router.delete("/:id", inspection_controller.delete_inspection);

export default router;
    