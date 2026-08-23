import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { configs } from '../../configs/index.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { assertCanWriteOrgResource, resolveCallerOrgContext } from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';
import {
  buildAiHeaders,
  fetchWithTimeout,
  LLM_CALL_TIMEOUT_MS,
  wrapAiServiceError,
} from '../ai/ai.service.js';

const get_all_supplier_from_db = async (req: Request) => {
  const { searchTerm, page, limit } = req.query;
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);

  const pagination = paginationHelper({ page: page as string, limit: limit as string });
  const { skip, limit: limitNumber } = pagination;

  const whereCondition: Prisma.SupplierWhereInput = {
    org_account_id: ctx.organizationId,
    ...(searchTerm && {
      name: {
        contains: searchTerm as string,
        mode: 'insensitive',
      },
    }),
  };
  const [data, total] = await Promise.all([
    prisma.supplier.findMany({
      where: whereCondition,
      skip,
      take: limitNumber,
      orderBy: {
        createdAt: 'desc',
      },
    }),
    prisma.supplier.count({
      where: whereCondition,
    }),
  ]);

  return {
    data,
    meta: buildPaginationMeta(pagination, total),
  };
};

const get_single_supplier_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const id = req.params?.id as string;
  const result = await prisma.supplier.findUnique({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!result) throw new AppError('Supplier not found', 404);
  return result;
};

const create_supplier_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const payload = req.body;
  payload.org_account_id = ctx.organizationId;
  try {
    const result = await prisma.supplier.create({ data: payload });
    return result;
  } catch (err) {
    // A case-insensitive per-org unique index on (org_account_id,
    // lower(trim(name))) was added by hand in the migration (Prisma's
    // schema DSL has no functional-index syntax) after the frontend's own
    // client-side AI-discovery dedup turned out to be the ONLY thing
    // preventing a duplicate -- see supplier.prisma's comment. Without this
    // catch, a race (two tabs, a slow dedup fetch, the manual-add form used
    // for a name just AI-added) surfaces as a raw 500 instead of the same
    // clean 409 every other unique-constraint race in this codebase returns.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('A supplier with this name already exists', 409);
    }
    throw err;
  }
};

const update_supplier_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const id = req.params.id as string;
  const existing = await prisma.supplier.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Supplier not found', 404);
  // Never trust org_account_id from the request body on an update -- same
  // cross-tenant integrity guard site.service.ts's update already applies.
  const { org_account_id: _ignored, ...safeBody } = req.body;
  try {
    const result = await prisma.supplier.update({
      where: { id },
      data: { ...safeBody, org_account_id: ctx.organizationId },
    });
    return result;
  } catch (err) {
    // Same race as create_supplier_into_db -- renaming a supplier to a
    // name that collides with another existing one hits the same
    // case-insensitive per-org unique index.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('A supplier with this name already exists', 409);
    }
    throw err;
  }
};

const delete_supplier_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const id = req.params.id as string;
  const existing = await prisma.supplier.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Supplier not found', 404);
  const result = await prisma.supplier.delete({
    where: { id, org_account_id: ctx.organizationId },
  });
  return result;
};

// Zero-input supplier discovery (mirrors onboarding's identify_company /
// site-discovery pattern, #96) -- searches for the org's real suppliers
// via aexa-ai's /company-suppliers (web search + LLM extraction) instead
// of requiring the user to manually type every supplier in. Returns a
// DRAFT list; nothing is persisted here. The frontend presents candidates
// for the user to accept/reject/edit, then POSTs accepted ones to the
// existing create_supplier endpoint with ai_generated: true and
// source_info set -- same draft-then-commit shape as onboarding's
// draft-sites-then-commit_onboarding.
const discover_suppliers_for_org = async (req: Request) => {
  try {
    const user = req.user as JwtPayloadType;
    const ctx = await resolveCallerOrgContext(user.accountId);
    // Same gate as every other AI-invoking endpoint (e.g. ai.service.ts's
    // generate_template_with_prompt_with_ai) -- this triggers a real,
    // cost-bearing external search+LLM call, not a plain read, so it must
    // not be reachable by read-only roles (VIEWER/LIGHT_USER) even though
    // it doesn't write anything itself.
    assertCanWriteOrgResource(ctx);

    // Optional override lets a caller search for a specific operating
    // entity name distinct from the org's registered profile name (e.g.
    // a subsidiary/brand name) -- falls back to the org profile when
    // omitted, which is the common case.
    let companyName = (req.body?.company_name as string | undefined)?.trim();
    if (!companyName) {
      const profile = await prisma.organizationProfile.findUnique({
        where: { accountId: ctx.organizationId },
        select: { organizationName: true },
      });
      companyName = profile?.organizationName;
    }
    if (!companyName) {
      throw new AppError(
        'No company name available to search -- set an organization profile name first, or pass company_name explicitly.',
        400,
      );
    }

    let aiResponse: Response;
    try {
      aiResponse = await fetchWithTimeout(
        `${configs.ai_server_end_point}/company-suppliers`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...buildAiHeaders(ctx.organizationId),
          },
          body: JSON.stringify({ company_name: companyName }),
        },
        LLM_CALL_TIMEOUT_MS,
      );
    } catch (fetchError) {
      // Same AbortError -> 504 special-case as compliance.service.ts's
      // suggest-regulatory-sources call site -- fetchWithTimeout aborts via
      // AbortController on LLM_CALL_TIMEOUT_MS, which fetch surfaces as a
      // DOMException named 'AbortError'. Left uncaught, that falls into the
      // outer catch/wrapAiServiceError below and comes out as the same
      // generic 500 as a genuine failure, indistinguishable to the
      // frontend -- which already branches on 504 to show a distinct
      // "search timed out" toast (SupplierDiscoveryPanel.tsx) that,
      // without this, could never actually fire.
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        throw new AppError('Supplier discovery timed out', 504);
      }
      throw fetchError;
    }
    if (!aiResponse.ok) {
      throw new AppError(`AI service error: ${aiResponse.status}`, 502);
    }
    const data = await aiResponse.json();
    return { suppliers_information: data?.suppliers_information ?? [] };
  } catch (error) {
    return wrapAiServiceError(error, 'Failed to discover suppliers');
  }
};

export const supplier_service = {
  get_all_supplier_from_db,
  get_single_supplier_from_db,
  create_supplier_into_db,
  update_supplier_into_db,
  delete_supplier_from_db,
  discover_suppliers_for_org,
};
