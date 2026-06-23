import { Request } from 'express';
import * as fs from 'fs';
import { configs } from '../../configs/index.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { recommendation_validations } from '../recommendation/recommendation.validation.js';
import { mapTemplateData } from '../template/template.utils.js';
import { template_validations } from '../template/template.validation.js';

const generate_template_with_prompt_with_ai = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const { prompt } = req.body;

    if (!prompt) {
      throw new AppError('Prompt is required', 400);
    }
    const aiResponse = await fetch(`${configs.ai_server_end_point}/template_from_topic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topic: prompt,
        organization_username: user.accountId,
      }),
    });
    const data = await aiResponse.json();
    // verify with schema
    const parseData = await template_validations.create_template.parseAsync(data?.data);

    // make final payload
    const finalPayload = mapTemplateData(parseData, user?.accountId);

    const result = await prisma.template.create({
      data: finalPayload,
    });

    return result;
  } catch (error: any) {
    throw new AppError(
      error?.message || 'Failed to generate template with AI',
      error?.statusCode || 500,
    );
  }
};

const generate_template_with_pdf_with_ai = async (req: Request) => {
  const file = req?.file;
  try {
    const user = req.user as JwtPayloadType;

    if (!file) {
      throw new AppError('File is required', 400);
    }

    const fileBuffer = fs.readFileSync(file.path);

    const blob = new Blob([fileBuffer], {
      type: file.mimetype,
    });

    const formData = new FormData();

    formData.append('file', blob, file.originalname);
    formData.append('organization_username', user.accountId);
    const aiResponse = await fetch(`${configs.ai_server_end_point}/template_from_pdf`, {
      method: 'POST',
      body: formData,
    });
    const data = await aiResponse.json();

    const parseData = await template_validations.create_template.parseAsync(data?.data);

    const finalPayload = mapTemplateData(parseData, user.accountId);

    const result = await prisma.template.create({
      data: finalPayload,
    });

    return result;
  } catch (error: any) {
    throw new AppError(
      error?.message || 'Failed to generate template from PDF',
      error?.statusCode || 500,
    );
  } finally {
    if (file?.path) {
      fs.unlinkSync(file?.path);
    }
  }
};

const generate_template_with_risk_with_ai = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const riskId = req?.body?.riskId as string;

    if (!riskId) {
      throw new AppError('Risk ID is required', 400);
    }

    const risk = await prisma.risk.findUnique({
      where: {
        id: riskId,
      },
    });

    if (!risk) {
      throw new AppError('Risk not found', 404);
    }

    const aiResponse = await fetch(`${configs.ai_server_end_point}/tamplate_from_risk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
        control_operating_eff: risk.control_operating_eff,
      }),
    });

    const data = await aiResponse.json();
    // verify with schema
    const parseData = await template_validations.create_template.parseAsync(data?.data);
    // make final payload
    const finalPayload = mapTemplateData(parseData, user?.accountId);

    const result = await prisma.template.create({
      data: finalPayload,
    });

    return result;
  } catch (error: any) {
    throw new AppError(
      error?.message || 'Failed to generate template from risk',
      error?.statusCode || 500,
    );
  }
};

const generate_recommendation_with_inspection_from_ai = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const inspectionId = req?.body?.inspectionId as string;

  // check inspection exist or not
  const isInspectionExist = await prisma.inspection.findFirst({
    where: {
      id: inspectionId,
    },
    include: {
      questionAnswers: {
        include: {
          question: {
            select: {
              question: true,
            },
          },
        },
      },
    },
  });

  if (!isInspectionExist) {
    throw new AppError('Inspection Not found !!', 404);
  }
  if (isInspectionExist.orgAccountId !== user.accountId) {
    throw new AppError('You are not authorized to access this inspection !!', 403);
  }

  // check recommendation exist or not
  const isRecommendationExist = await prisma.recommendation.findFirst({
    where: {
      inspectionId: inspectionId,
    },
  });
  if (isRecommendationExist) {
    throw new AppError('Recommendation already exist !!', 400);
  }
  const questions = isInspectionExist?.questionAnswers?.map((item) => ({
    question: item.question.question,
    answer: item.answer,
    note: item.note,
  }));

  const aiPayload = {
    organization_username: user.accountId,
    questions: questions,
  };

  // Call ai api for generating recommendation
  try {
    const aiResponse = await fetch(
      `${configs.ai_server_end_point}/generate_recommendations_from_answer`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(aiPayload),
      },
    );
    const data = await aiResponse.json();
    if (data) {
      const results = data.results.map((item: any) => ({
        question: item.question || ' ',
        observation: item.observation || ' ',
        standard: item.standard || ' ',
        recommendation: item.recommendation || ' ',
      }));
      const final_payload = {
        results,
        summary: data.all_over_recommendation,
        orgAccountId: user?.accountId,
        inspectionId,
        ...(isInspectionExist.riskId && {
          riskId: isInspectionExist.riskId,
        }),
        ...(isInspectionExist.siteId && {
          siteId: isInspectionExist.siteId,
        }),
      };
      const validateDate =
        await recommendation_validations.create_recommendation.parseAsync(final_payload);
      const result = await prisma.recommendation.create({
        data: {
          summary: validateDate.summary,
          orgAccountId: validateDate.orgAccountId,
          inspectionId: validateDate.inspectionId,
          riskId: validateDate.riskId,
          siteId: validateDate.siteId,

          questions: {
            create: validateDate.results.map((item: any) => ({
              question: item.question,
              observation: item.observation,
              standard: item.standard,
              recommendation: item.recommendation,
            })),
          },
        },
        include: {
          questions: true,
        },
      });
      return result;
    }
  } catch (error: any) {
    throw new AppError(
      error?.message || 'Failed to generate recommendation from inspection',
      error?.statusCode || 500,
    );
  }
};

// pinecone manage area
const upload_pdf_into_pinecone_via_ai = async (req: Request) => {
  const file = req?.file;
  try {
    const user = req.user as JwtPayloadType;

    if (!file) {
      throw new AppError('File is required', 400);
    }

    const fileBuffer = fs.readFileSync(file.path);

    const blob = new Blob([fileBuffer], {
      type: file.mimetype,
    });

    const formData = new FormData();

    formData.append('file', blob, file.originalname);
    formData.append('organization_username', user.accountId);
    const aiResponse = await fetch(`${configs.ai_server_end_point}/upload-pdf-to-pinecone`, {
      method: 'POST',
      body: formData,
    });
    const data = await aiResponse.json();

    // database payload
    const databasePayload = {
      fileName: file.originalname,
      fileId: data.file_id,
      orgAccountId: user.accountId,
      fileSize: String(file.size),
    };
    const result = await prisma.pineconeDocument.create({
      data: databasePayload,
    });

    return result;
  } catch (error: any) {
    throw new AppError(error?.message || 'Failed to upload file', error?.statusCode || 500);
  } finally {
    if (file?.path) {
      fs.unlinkSync(file?.path);
    }
  }
};

const get_all_pinecone_data_from_database = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const data = await prisma.pineconeDocument.findMany({
    where: {
      orgAccountId: user.accountId,
    },
  });
  return data;
};
const delete_pinecone_data_from_database = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const fileName = req.query.fileName as string;

  await fetch(
    `${configs.ai_server_end_point}/delete-vectors-by-filename?file_name=${fileName}&organization_username=${user.accountId}`,
    {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );

  const result = await prisma.pineconeDocument.deleteMany({
    where: {
      fileName,
      orgAccountId: user.accountId,
    },
  });
  return result;
};

export const ai_service = {
  generate_template_with_prompt_with_ai,
  generate_template_with_pdf_with_ai,
  generate_template_with_risk_with_ai,
  generate_recommendation_with_inspection_from_ai,
  upload_pdf_into_pinecone_via_ai,
  get_all_pinecone_data_from_database,
  delete_pinecone_data_from_database,
};
