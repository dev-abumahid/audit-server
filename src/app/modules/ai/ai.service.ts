import { Request } from "express";
import * as fs from "fs";
import { configs } from "../../configs/index.js";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../utils/app_error.js";
import { JwtPayloadType } from "../../utils/JWT.js";
import { mapTemplateData } from "../template/template.utils.js";
import { template_validations } from "../template/template.validation.js";

const generate_template_with_prompt_with_ai = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const { prompt } = req.body;

    if (!prompt) {
      throw new AppError("Prompt is required", 400);
    }

    const aiResponse = await fetch(
      `${configs.ai_server_end_point}/template_from_topic`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          topic: prompt
        }),
      }
    );
    const { data } = await aiResponse.json();

    // verify with schema
    const parseData =
      await template_validations.create_template.parseAsync(data);

    // make final payload
    const finalPayload = mapTemplateData(
      parseData,
      user?.accountId
    );

    const result = await prisma.template.create({
      data: finalPayload,
    });

    return result;
  } catch (error: any) {
    console.error("generate_template_with_prompt_with_ai:", error);

    throw new AppError(
      error?.message || "Failed to generate template with AI",
      error?.statusCode || 500
    );
  }
};

const generate_template_with_pdf_with_ai = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const file = req?.file;

    if (!file) {
      throw new AppError("File is required", 400);
    }

    const fileBuffer = fs.readFileSync(file.path);

    const blob = new Blob([fileBuffer], {
      type: file.mimetype,
    });

    const formData = new FormData();

    formData.append("file", blob, file.originalname);
    const aiResponse = await fetch(
      `${configs.ai_server_end_point}/template_from_pdf`,
      {
        method: "POST",
        body: formData,
      }
    );

    const { data } = await aiResponse.json();

    const parseData =
      await template_validations.create_template.parseAsync(data);

    const finalPayload = mapTemplateData(
      parseData,
      user.accountId
    );

    const result = await prisma.template.create({
      data: finalPayload,
    });

    return result;
  } catch (error: any) {
    console.error("generate_template_with_pdf_with_ai:", error);
    throw new AppError(
      error?.message || "Failed to generate template from PDF",
      error?.statusCode || 500
    );
  }
};

const generate_template_with_risk_with_ai = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const riskId = req?.body?.riskId as string;

    if (!riskId) {
      throw new AppError("Risk ID is required", 400);
    }

    const risk = await prisma.risk.findUnique({
      where: {
        id: riskId,
      },
    });

    if (!risk) {
      throw new AppError("Risk not found", 404);
    }

    const aiResponse = await fetch(
      `${configs.ai_server_end_point}/tamplate_from_risk`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: risk.name,
          description: risk.description,
          category: risk.category,
          inherent_score: risk.inherent_score,
          residual_score: risk.residual_score,
          pagerank_score: risk.pagerank_score,
          financial_impact_min: risk.financial_impact_min,
          financial_impact_max: risk.financial_impact_max,
          probability: risk.probability,
          velocity: risk.velocity,
          trend: risk.trend,
          status: risk.status,
          ai_generated: risk.ai_generated,
          is_edited: risk.is_edited,
          site_id: risk.site_id,
          source_info: risk.source_info,
          control_design_eff: risk.control_design_eff,
          control_operating_eff: risk.control_operating_eff
        }),
      }
    );

    const data = await aiResponse.json();
    // verify with schema
    const parseData =
      await template_validations.create_template.parseAsync(
        data?.data
      );

    // make final payload
    const finalPayload = mapTemplateData(
      parseData,
      user?.accountId
    );

    const result = await prisma.template.create({
      data: finalPayload,
    });

    return result;
  } catch (error: any) {
    throw new AppError(
      error?.message || "Failed to generate template from risk",
      error?.statusCode || 500
    );
  }
};

export const ai_service = {
  generate_template_with_prompt_with_ai,
  generate_template_with_pdf_with_ai,
  generate_template_with_risk_with_ai,
};