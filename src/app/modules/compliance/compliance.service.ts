import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import uploadCloud from '../../utils/cloudinary.js';
import { JwtPayloadType } from '../../utils/JWT.js';
import { assertCanWriteOrgResource, resolveCallerOrgContext } from '../../utils/org_scope.js';
import { buildPaginationMeta, paginationHelper } from '../../utils/paginationHelper.js';

const get_all_compliance_from_db = async (req: Request) => {
  const { searchTerm, status, domain, page, limit } = req.query;
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);

  const pagination = paginationHelper({ page: page as string, limit: limit as string });
  const { skip, limit: limitNumber } = pagination;

  const whereCondition: Prisma.ComplianceObligationWhereInput = {
    org_account_id: ctx.organizationId,
    ...(status && { status: status as string }),
    ...(domain && { domain: domain as string }),
    ...(searchTerm && {
      OR: [
        {
          title: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
        {
          description: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
        {
          owner: {
            contains: searchTerm as string,
            mode: 'insensitive',
          },
        },
      ],
    }),
  };

  const [data, total] = await Promise.all([
    prisma.complianceObligation.findMany({
      where: whereCondition,
      skip,
      take: limitNumber,
      orderBy: {
        createdAt: 'desc',
      },
    }),
    prisma.complianceObligation.count({
      where: whereCondition,
    }),
  ]);

  return {
    data,
    meta: buildPaginationMeta(pagination, total),
  };
};

const get_single_compliance_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  const id = req.params?.id as string;
  const result = await prisma.complianceObligation.findUnique({
    where: { id, org_account_id: ctx.organizationId },
  });
  // Every sibling module's get_single_* throws 404 for a missing/cross-org
  // record rather than returning a bare 200 with data: null.
  if (!result) throw new AppError('Compliance obligation not found', 404);
  return result;
};

const create_compliance_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const payload = req.body;
  payload.org_account_id = ctx.organizationId;
  const result = await prisma.complianceObligation.create({ data: payload });
  return result;
};

const update_compliance_into_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const id = req.params.id as string;
  const existing = await prisma.complianceObligation.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Compliance obligation not found', 404);
  // Never trust org_account_id from the request body on an update — an
  // authorized (ADMIN/LEAD_AUDITOR) caller could otherwise reassign an
  // obligation to a different org's anchor account id, a cross-tenant
  // integrity issue even though ownership of the *existing* row was verified
  // above. Same guard audit.service.ts / site.service.ts apply.
  const { org_account_id: _ignored, ...safeBody } = req.body;
  const result = await prisma.complianceObligation.update({
    where: { id },
    data: { ...safeBody, org_account_id: ctx.organizationId },
  });
  return result;
};

const delete_compliance_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);
  assertCanWriteOrgResource(ctx);
  const id = req.params.id as string;
  // Existence check before delete, matching every sibling module — deleting a
  // missing/cross-org id would otherwise fall through to Prisma's raw P2025
  // (a 500) instead of the clean 404 the rest of the API returns.
  const existing = await prisma.complianceObligation.findFirst({
    where: { id, org_account_id: ctx.organizationId },
  });
  if (!existing) throw new AppError('Compliance obligation not found', 404);
  const result = await prisma.complianceObligation.delete({
    where: { id, org_account_id: ctx.organizationId },
  });
  return result;
};

/**
 * Uploads a compliance-evidence attachment to Cloudinary and returns its URL.
 * Two-step flow identical to action.service.ts's upload_action_attachment: the
 * frontend uploads the file here first, then includes the returned URL in the
 * `attachments` array on a subsequent create/update call — so this endpoint
 * itself doesn't touch any ComplianceObligation row and only needs auth, not
 * org-scoped lookup. Response shape ({ url }) matches the action endpoint the
 * frontend upload helper already expects.
 */
const upload_compliance_attachment_into_aws = async (req: Request) => {
  const file = req.file;
  if (!file) {
    throw new AppError('File is required', 400);
  }
  const result = await uploadCloud(file);
  return { url: result.secure_url };
};

// Scorecard banding per CDC spec 7.7: red <70%, orange 70-85%, green >85%.
// A cell/group with no applicable obligations (total 0) has no meaningful
// ratio — return 'none' so the frontend renders it as an empty/neutral cell
// rather than a misleading red 0%.
type ScoreBand = 'green' | 'orange' | 'red' | 'none';

const bandFor = (compliant: number, total: number): ScoreBand => {
  if (total === 0) return 'none';
  const ratio = compliant / total;
  if (ratio >= 0.85) return 'green';
  if (ratio >= 0.7) return 'orange';
  return 'red';
};

const scoreCell = (compliant: number, total: number) => ({
  compliant,
  total,
  ratio: total === 0 ? 0 : compliant / total,
  band: bandFor(compliant, total),
});

/**
 * Computed compliance scorecard, org-scoped. Returns an overall compliant/total
 * ratio plus breakdowns by domain and by site, and a site×domain matrix for the
 * red/orange/green grid the frontend renders. Compliant is defined as
 * status === 'compliant'. Computed from real rows at request time — no caching
 * needed at this scale (Phase 1).
 */
const get_compliance_scorecard_from_db = async (req: Request) => {
  const user = req.user as JwtPayloadType;
  const ctx = await resolveCallerOrgContext(user.accountId);

  const obligations = await prisma.complianceObligation.findMany({
    where: { org_account_id: ctx.organizationId },
    select: {
      status: true,
      domain: true,
      site_id: true,
      site: { select: { name: true } },
    },
  });

  const isCompliant = (status: string) => status === 'compliant';

  // Overall
  const overallTotal = obligations.length;
  const overallCompliant = obligations.filter((o) => isCompliant(o.status)).length;

  // By domain
  const domainMap = new Map<string, { compliant: number; total: number }>();
  // By site (null site_id === org-wide)
  const siteMap = new Map<
    string,
    { site_id: string | null; site_name: string | null; compliant: number; total: number }
  >();
  // Site × domain matrix
  const matrixMap = new Map<
    string,
    {
      site_id: string | null;
      site_name: string | null;
      domain: string;
      compliant: number;
      total: number;
    }
  >();

  for (const o of obligations) {
    const compliant = isCompliant(o.status) ? 1 : 0;
    const siteKey = o.site_id ?? '__org_wide__';
    const siteName = o.site?.name ?? null;

    const d = domainMap.get(o.domain) ?? { compliant: 0, total: 0 };
    d.compliant += compliant;
    d.total += 1;
    domainMap.set(o.domain, d);

    const s = siteMap.get(siteKey) ?? {
      site_id: o.site_id ?? null,
      site_name: siteName,
      compliant: 0,
      total: 0,
    };
    s.compliant += compliant;
    s.total += 1;
    siteMap.set(siteKey, s);

    const mKey = `${siteKey}::${o.domain}`;
    const m = matrixMap.get(mKey) ?? {
      site_id: o.site_id ?? null,
      site_name: siteName,
      domain: o.domain,
      compliant: 0,
      total: 0,
    };
    m.compliant += compliant;
    m.total += 1;
    matrixMap.set(mKey, m);
  }

  return {
    overall: scoreCell(overallCompliant, overallTotal),
    byDomain: Array.from(domainMap.entries())
      .map(([domain, v]) => ({ domain, ...scoreCell(v.compliant, v.total) }))
      .sort((a, b) => a.domain.localeCompare(b.domain)),
    bySite: Array.from(siteMap.values())
      .map((v) => ({
        site_id: v.site_id,
        site_name: v.site_name,
        ...scoreCell(v.compliant, v.total),
      }))
      .sort((a, b) => (a.site_name ?? '').localeCompare(b.site_name ?? '')),
    matrix: Array.from(matrixMap.values()).map((v) => ({
      site_id: v.site_id,
      site_name: v.site_name,
      domain: v.domain,
      ...scoreCell(v.compliant, v.total),
    })),
  };
};

export const compliance_service = {
  get_all_compliance_from_db,
  get_single_compliance_from_db,
  create_compliance_into_db,
  update_compliance_into_db,
  delete_compliance_from_db,
  upload_compliance_attachment_into_aws,
  get_compliance_scorecard_from_db,
};
