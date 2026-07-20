import { Request } from 'express';
import * as fs from 'fs';
import { configs } from '../../configs/index.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import {
  assertCanWriteOrgResource,
  assertCanWriteToInspection,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import { recommendation_validations } from '../recommendation/recommendation.validation.js';
import { mapTemplateData } from '../template/template.utils.js';
import { template_validations } from '../template/template.validation.js';
import { ai_validations } from './ai.validation.js';

// Every outbound call to aexa-ai must carry this — the AI service enforces
// it as a global app-level auth dependency and rejects requests without it.
// Exported so other modules calling aexa-ai directly (note, inspection) can
// reuse the same header instead of each hand-rolling it.
export const AI_INTERNAL_SECRET_HEADER = {
  'X-Internal-Secret': configs.ai_internal_secret,
};

const generate_template_with_prompt_with_ai = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);
    assertCanWriteOrgResource(ctx);
    const { prompt } = req.body;

    if (!prompt) {
      throw new AppError('Prompt is required', 400);
    }
    const aiResponse = await fetch(`${configs.ai_server_end_point}/template_from_topic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...AI_INTERNAL_SECRET_HEADER,
      },
      body: JSON.stringify({
        topic: prompt,
        organization_username: ctx.organizationId,
      }),
    });
    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
    const data = await aiResponse.json();
    // verify with schema
    const parseData = await template_validations.create_template.parseAsync(data?.data);

    // make final payload
    const finalPayload = mapTemplateData(parseData, ctx.organizationId);

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
    const ctx = await resolveCallerOrgContext(user.accountId);
    assertCanWriteOrgResource(ctx);

    if (!file) {
      throw new AppError('File is required', 400);
    }

    const fileBuffer = fs.readFileSync(file.path);

    const blob = new Blob([fileBuffer], {
      type: file.mimetype,
    });

    const formData = new FormData();

    formData.append('file', blob, file.originalname);
    formData.append('organization_username', ctx.organizationId);
    const aiResponse = await fetch(`${configs.ai_server_end_point}/template_from_pdf`, {
      method: 'POST',
      headers: AI_INTERNAL_SECRET_HEADER,
      body: formData,
    });
    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
    const data = await aiResponse.json();

    const parseData = await template_validations.create_template.parseAsync(data?.data);

    const finalPayload = mapTemplateData(parseData, ctx.organizationId);

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
    const ctx = await resolveCallerOrgContext(user.accountId);
    assertCanWriteOrgResource(ctx);
    const riskId = req?.body?.riskId as string;

    if (!riskId) {
      throw new AppError('Risk ID is required', 400);
    }

    const risk = await prisma.risk.findUnique({
      where: {
        id: riskId,
        org_account_id: ctx.organizationId,
      },
    });

    if (!risk) {
      throw new AppError('Risk not found', 404);
    }

    const aiResponse = await fetch(`${configs.ai_server_end_point}/tamplate_from_risk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...AI_INTERNAL_SECRET_HEADER,
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

    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
    const data = await aiResponse.json();
    // verify with schema
    const parseData = await template_validations.create_template.parseAsync(data?.data);
    // make final payload
    const finalPayload = mapTemplateData(parseData, ctx.organizationId);

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

// Generates candidate risks for a site from aexa-ai's /risk_analysis
// endpoint. Unlike the other AI proxies above, this one does not persist
// anything — it returns the raw suggestions so the caller can review and
// selectively import them via the existing POST /risk route (same pattern
// SitesEntities.tsx's manual "add risk" flow already uses), rather than
// auto-creating Risk rows the user never asked for.
const analyze_site_risks_with_ai = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);
    assertCanWriteOrgResource(ctx);
    const siteId = req?.body?.siteId as string;

    const site = await prisma.site.findUnique({
      where: {
        id: siteId,
        org_account_id: ctx.organizationId,
      },
    });

    if (!site) {
      throw new AppError('Site not found', 404);
    }

    // Deliberately not including a system_prompt field — see the comment on
    // ai_validations.analyze_site_risks. site_legal_entity has no analog on
    // the Site model yet, so it's sent empty rather than guessed.
    const aiResponse = await fetch(`${configs.ai_server_end_point}/risk_analysis`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...AI_INTERNAL_SECRET_HEADER,
      },
      body: JSON.stringify({
        site_name: site.name,
        site_location: site.location || '',
        site_legal_entity: '',
        site_primary_activity: site.activity || '',
        site_country: site.country || '',
        site_revenue: String(site.revenue),
        site_employees: String(site.employees_count),
        site_type: site.site_type,
      }),
    });

    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
    const data = await aiResponse.json();
    const parsed = await ai_validations.risk_analysis_response.parseAsync(data);

    return parsed.risks;
  } catch (error: any) {
    throw new AppError(error?.message || 'Failed to analyze site risks', error?.statusCode || 500);
  }
};

const generate_recommendation_with_inspection_from_ai = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const inspectionId = req?.body?.inspectionId as string;

  // check inspection exist or not — org filter is part of the query itself
  // (not a post-fetch check) so a cross-org id and a genuinely nonexistent
  // id are indistinguishable to the caller: both 404, no existence oracle.
  // Same shape as the fixed IDORs in inspection.service.ts's
  // update_inspection_into_db / delete_inspection_from_db.
  const isInspectionExist = await prisma.inspection.findFirst({
    where: {
      id: inspectionId,
      orgAccountId: ctx.organizationId,
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
    throw new AppError('Inspection not found', 404);
  }
  await assertCanWriteToInspection(ctx, inspectionId);

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
    organization_username: ctx.organizationId,
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
          ...AI_INTERNAL_SECRET_HEADER,
        },
        body: JSON.stringify(aiPayload),
      },
    );
    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
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
        orgAccountId: ctx.organizationId,
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
    const ctx = await resolveCallerOrgContext(user.accountId);
    assertCanWriteOrgResource(ctx);

    if (!file) {
      throw new AppError('File is required', 400);
    }

    const fileBuffer = fs.readFileSync(file.path);

    const blob = new Blob([fileBuffer], {
      type: file.mimetype,
    });

    const formData = new FormData();

    formData.append('file', blob, file.originalname);
    formData.append('organization_username', ctx.organizationId);
    const aiResponse = await fetch(`${configs.ai_server_end_point}/upload-pdf-to-pinecone`, {
      method: 'POST',
      headers: AI_INTERNAL_SECRET_HEADER,
      body: formData,
    });
    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
    const data = await aiResponse.json();

    // database payload
    const databasePayload = {
      fileName: file.originalname,
      fileId: data.file_id,
      orgAccountId: ctx.organizationId,
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

// Closes #35 — aexa-ai's GET /upload-status/{file_id} had no caller anywhere.
// The upload itself already returns a synchronous "success" (a
// PineconeDocument row is created as soon as aexa-ai hands back a file_id),
// but the actual embedding into Pinecone runs async in the background on
// the aexa-ai side — so that immediate response doesn't mean the file is
// actually queryable yet. This proxies aexa-ai's real job-status store.
const check_upload_file_status_from_ai = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const { fileId } = req.params as { fileId: string };

  // fileId (not the PineconeDocument's own id) is what aexa-ai's job store
  // is keyed on — org-scoped lookup so a caller can't poll another org's
  // upload status by guessing/enumerating file ids.
  const document = await prisma.pineconeDocument.findFirst({
    where: { fileId: fileId, orgAccountId: ctx.organizationId },
  });
  if (!document) {
    throw new AppError('Upload not found', 404);
  }

  // aexa-ai's own /upload-status/{file_id} now requires organization_username
  // as a defense-in-depth check (issue #79 on aexa-ai) -- it returns 404 if
  // the caller-supplied org doesn't match the org the job was created under.
  // We already know the org from the Prisma lookup above, so pass it through.
  const aiResponse = await fetch(
    `${configs.ai_server_end_point}/upload-status/${fileId}?organization_username=${encodeURIComponent(ctx.organizationId)}`,
    {
      headers: AI_INTERNAL_SECRET_HEADER,
    },
  );
  if (aiResponse.status === 404) {
    throw new AppError('Upload status not found', 404);
  }
  if (!aiResponse.ok) {
    throw new AppError(`AI service error: ${aiResponse.status}`, 502);
  }
  return aiResponse.json();
};

const get_all_pinecone_data_from_database = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const data = await prisma.pineconeDocument.findMany({
    where: {
      orgAccountId: ctx.organizationId,
    },
  });
  return data;
};
const delete_pinecone_data_from_database = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const fileName = req.query.fileName as string;

  const aiResponse = await fetch(
    `${configs.ai_server_end_point}/delete-vectors-by-filename?file_name=${fileName}&organization_username=${ctx.organizationId}`,
    {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...AI_INTERNAL_SECRET_HEADER,
      },
    },
  );
  // Every other AI-service call in this file throws on a non-ok response;
  // this one proceeded to delete the local DB record regardless, letting
  // the DB and the actual Pinecone vector store drift out of sync on a
  // failed upstream delete (network blip, secret mismatch, file already
  // gone) with no error surfaced to the caller. Found by independent
  // review.
  //
  // 404 specifically means aexa-ai found no vectors matching this file
  // (aexa-ai#30) -- not a service failure. The desired end state (no
  // vector, no local record) is already true, so this falls through to
  // the same local cleanup as a genuine deletion instead of aborting it.
  if (!aiResponse.ok && aiResponse.status !== 404) {
    throw new AppError(`AI service error: ${aiResponse.status}`, 502);
  }

  const result = await prisma.pineconeDocument.deleteMany({
    where: {
      fileName,
      orgAccountId: ctx.organizationId,
    },
  });
  return result;
};

export const ai_service = {
  generate_template_with_prompt_with_ai,
  generate_template_with_pdf_with_ai,
  generate_template_with_risk_with_ai,
  generate_recommendation_with_inspection_from_ai,
  analyze_site_risks_with_ai,
  upload_pdf_into_pinecone_via_ai,
  check_upload_file_status_from_ai,
  get_all_pinecone_data_from_database,
  delete_pinecone_data_from_database,
};
