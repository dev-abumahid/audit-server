import { Request } from 'express';
import * as fs from 'fs';
import { configs } from '../../configs/index.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import {
  assertCanWriteOrgResource,
  assertCanWriteToInspection,
  resolveCallerOrgContext,
} from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';
import { mintOrgToken, ORG_TOKEN_HEADER } from '../../utils/org_token.js';
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

// Issue #56 stage 2 — every aexa-server -> aexa-ai call site that has a
// resolved caller org should use this instead of AI_INTERNAL_SECRET_HEADER
// directly: it attaches the shared-secret header AND a freshly minted,
// short-lived signed org-identity token (see utils/org_token.ts), so
// aexa-ai's rate limiter keys on a real authenticated org instead of a
// self-reported header. Centralizing this here means a future new call site
// gets both headers by construction instead of a developer having to
// remember to hand-roll the org token on top of the secret header.
export const buildAiHeaders = (orgAccountId: string): Record<string, string> => ({
  ...AI_INTERNAL_SECRET_HEADER,
  [ORG_TOKEN_HEADER]: mintOrgToken(orgAccountId),
});

// Closes #134 — every AI proxy function below re-wraps whatever it catches
// (a ZodError from response-shape validation, a raw Prisma error, a
// fetch/network failure, ...) as `new AppError(error?.message || ..., ...)`.
// `error.message` on those can carry upstream/internal detail (Pinecone
// error text, Prisma's own error strings, Zod's field-path descriptions of
// our internal response schema) straight through to the client.
//
// The AppErrors we throw ourselves *within* these functions (validation
// 400s, org-scoped 404s, and the "AI service error: <status>" 502s below)
// are already client-safe by construction, so those are rethrown unchanged.
// Everything else is logged with full detail server-side and replaced with
// a generic client-facing message — never forward raw `error.message` for
// an error we didn't craft ourselves.
export const wrapAiServiceError = (error: unknown, fallbackMessage: string): never => {
  if (error instanceof AppError) {
    throw error;
  }
  logger.error({ err: error }, fallbackMessage);
  throw new AppError(fallbackMessage, 500);
};

// Issue #233 — none of the 8 outbound fetch calls to aexa-ai below had a
// timeout, so a hung/slow aexa-ai process (or a dropped connection that
// never resolves) left the request pending indefinitely. Follows the same
// AbortController + `finally { clearTimeout(timeout) }` pattern already
// established by intelligence/rss_scraper.ts's fetchRSSFeed.
//
// Three tiers, not one blanket value, because these are meaningfully
// different operations:
//   - LLM_CALL_TIMEOUT_MS: plain LLM-completion calls (template/recommendation
//     /risk-analysis generation) — no OCR/embedding work, should return in
//     well under a minute under normal load.
//   - PDF_PROCESSING_TIMEOUT_MS: PDF-based calls (OCR/parsing a document,
//     embedding it into Pinecone) — genuinely slower, needs more headroom.
//   - LIGHTWEIGHT_CALL_TIMEOUT_MS: cheap status/delete lookups against
//     Pinecone metadata, not a generation call — should return almost
//     immediately, so a short timeout is appropriate.
//
// Note on #232's 60s org-identity JWT (minted per call via buildAiHeaders,
// see utils/org_token.ts): that token is only used as the RATE-LIMIT KEY on
// aexa-ai's side, not as a precondition for the request to succeed or fail.
// A fetch timeout LONGER than 60s (like PDF_PROCESSING_TIMEOUT_MS below)
// does not cause an error if the token has already expired by the time
// aexa-ai looks at it — it just means aexa-ai's rate limiter falls back to
// IP-based keying for that one call (fails safe, per #232's design). So
// these timeouts are sized for realistic operation duration, not artificially
// capped at 60s to "match" the token TTL — the two are unrelated constraints.
const LLM_CALL_TIMEOUT_MS = 45_000;
const PDF_PROCESSING_TIMEOUT_MS = 90_000;
const LIGHTWEIGHT_CALL_TIMEOUT_MS = 15_000;

// Shared by all 8 call sites below instead of each one hand-rolling its own
// AbortController/setTimeout/finally boilerplate (found duplicated verbatim
// 8 times by independent review). Centralizes the abort-and-cleanup logic
// in one place so a 9th call site added later gets it for free by using this
// instead of raw `fetch`.
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

const generate_template_with_prompt_with_ai = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);
    assertCanWriteOrgResource(ctx);
    const { prompt } = req.body;

    if (!prompt) {
      throw new AppError('Prompt is required', 400);
    }
    const aiResponse = await fetchWithTimeout(
      `${configs.ai_server_end_point}/template_from_topic`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAiHeaders(ctx.organizationId),
        },
        body: JSON.stringify({
          topic: prompt,
          organization_username: ctx.organizationId,
        }),
      },
      LLM_CALL_TIMEOUT_MS,
    );
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
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to generate template with AI');
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
    const aiResponse = await fetchWithTimeout(
      `${configs.ai_server_end_point}/template_from_pdf`,
      {
        method: 'POST',
        headers: buildAiHeaders(ctx.organizationId),
        body: formData,
      },
      PDF_PROCESSING_TIMEOUT_MS,
    );
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
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to generate template from PDF');
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

    const aiResponse = await fetchWithTimeout(
      `${configs.ai_server_end_point}/tamplate_from_risk`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAiHeaders(ctx.organizationId),
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
      },
      LLM_CALL_TIMEOUT_MS,
    );

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
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to generate template from risk');
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
    const aiResponse = await fetchWithTimeout(
      `${configs.ai_server_end_point}/risk_analysis`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAiHeaders(ctx.organizationId),
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
      },
      LLM_CALL_TIMEOUT_MS,
    );

    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
    const data = await aiResponse.json();
    const parsed = await ai_validations.risk_analysis_response.parseAsync(data);

    return parsed.risks;
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to analyze site risks');
  }
};

const generate_recommendation_with_inspection_from_ai = async (req: Request) => {
  // Issue #134 follow-up: the org/inspection lookups below used to run
  // outside this try block, so a raw Prisma error from them bypassed
  // wrapAiServiceError entirely and reached the client via
  // global_error_handler's generic `instanceof Error` fallback. The whole
  // function body is wrapped now, same as every other AI-proxy function in
  // this file.
  try {
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
    const aiResponse = await fetchWithTimeout(
      `${configs.ai_server_end_point}/generate_recommendations_from_answer`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAiHeaders(ctx.organizationId),
        },
        body: JSON.stringify(aiPayload),
      },
      LLM_CALL_TIMEOUT_MS,
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
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to generate recommendation from inspection');
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
    const aiResponse = await fetchWithTimeout(
      `${configs.ai_server_end_point}/upload-pdf-to-pinecone`,
      {
        method: 'POST',
        headers: buildAiHeaders(ctx.organizationId),
        body: formData,
      },
      PDF_PROCESSING_TIMEOUT_MS,
    );
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
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to upload file');
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
  try {
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
    const aiResponse = await fetchWithTimeout(
      `${configs.ai_server_end_point}/upload-status/${fileId}?organization_username=${encodeURIComponent(ctx.organizationId)}`,
      {
        headers: buildAiHeaders(ctx.organizationId),
      },
      LIGHTWEIGHT_CALL_TIMEOUT_MS,
    );
    if (aiResponse.status === 404) {
      throw new AppError('Upload status not found', 404);
    }
    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
    return await aiResponse.json();
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to check upload status');
  }
};

const get_all_pinecone_data_from_database = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);
    const whereCondition = { orgAccountId: ctx.organizationId };

    // Was an unconditional findMany with no limit, unlike every other list
    // endpoint in this codebase (see note/template/recommendation list
    // endpoints) — an org with many uploaded documents got an unbounded
    // response. See issue #132.
    const pagination = paginationHelper({
      page: req.query.page as string,
      limit: req.query.limit as string,
    });
    const [data, total] = await Promise.all([
      prisma.pineconeDocument.findMany({
        where: whereCondition,
        skip: pagination.skip,
        take: pagination.limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.pineconeDocument.count({ where: whereCondition }),
    ]);

    return {
      data,
      meta: buildPaginationMeta(pagination, total),
    };
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to fetch uploaded documents');
  }
};
const delete_pinecone_data_from_database = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);
    assertCanWriteOrgResource(ctx);
    const fileName = req.query.fileName as string;

    // file_name goes in the request body, not the query string --
    // aexa-ai#74: a filename in the URL ends up in access logs, browser
    // history, and proxy logs. JSON encoding also sidesteps the query-string
    // misparsing that (&, =, #, spaces, unicode) used to cause (#131).
    // organization_username stays a query param -- it's a tenant identifier,
    // not user-supplied content, matching aexa-ai's endpoint contract.
    const deleteParams = new URLSearchParams({
      organization_username: ctx.organizationId,
    });

    const aiResponse = await fetchWithTimeout(
      `${configs.ai_server_end_point}/delete-vectors-by-filename?${deleteParams.toString()}`,
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...buildAiHeaders(ctx.organizationId),
        },
        body: JSON.stringify({ file_name: fileName }),
      },
      LIGHTWEIGHT_CALL_TIMEOUT_MS,
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
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to delete uploaded document');
  }
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
