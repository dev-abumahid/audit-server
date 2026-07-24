import bcrypt from 'bcrypt';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../utils/app_error.js';
import { SAFE_ACCOUNT_SELECT } from '../account/account.constants.js';

// A Prisma transaction client OR the base client — createOrgAccount runs the
// same four inserts either standalone (POST /organization) or composed inside
// a larger transaction (POST /onboarding/commit), so it must accept both.
export type PrismaTxClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface CreateOrgAccountInput {
  organizationName: string;
  email: string;
  password: string;
  sector?: string | null;
  country?: string | null;
  organizationLocation?: string | null;
  organizationWebsite?: string | null;
  organizationDescription?: string | null;
  organizationPhone?: string | null;
  organizationLogo?: string | null;
}

/**
 * Creates a new organization tenant inside the given transaction client:
 *
 *   1. Account(role=ORGANIZATION) — the tenant root every Site/Risk/Kri hangs
 *      off via org_account_id (see CLAUDE.md org-scoping table).
 *   2. OrganizationProfile — name + optional sector/country (#96).
 *   3. Organization + OrgMember(ADMIN/ACTIVE) — issue #55's role-hierarchy
 *      layer, so the tenant has a real admin member on day one rather than
 *      only the legacy Account-as-tenant row.
 *
 * This mirrors EXACTLY what account.service.ts's signup transaction and
 * src/scripts/backfill-org-membership.ts already do, factored out so
 * POST /organization and POST /onboarding/commit share one implementation
 * rather than duplicating (and risking divergence in) org-creation logic.
 *
 * Admin-provisioned accounts are created already-verified: unlike self-serve
 * signup there is no OTP/email round-trip here (an internal admin is creating
 * the tenant), and auth() requires isAccountVerified for the org's members to
 * be able to use it.
 *
 * The caller is responsible for the email-uniqueness pre-check (see
 * assertEmailAvailable) BEFORE opening the transaction, so a duplicate email
 * fails fast with a clean 400 rather than surfacing a raw Prisma P2002.
 */
export async function createOrgAccount(tx: PrismaTxClient, input: CreateOrgAccountInput) {
  const hashPassword = bcrypt.hashSync(input.password, 10);

  const account = await tx.account.create({
    data: {
      email: input.email,
      password: hashPassword,
      role: 'ORGANIZATION',
      isAccountVerified: true,
    },
    // Never let the bcrypt hash leave the process boundary — same guard the
    // signup path uses (#165/#167).
    select: SAFE_ACCOUNT_SELECT,
  });

  const profile = await tx.organizationProfile.create({
    data: {
      organizationName: input.organizationName,
      accountId: account.id,
      sector: input.sector ?? null,
      country: input.country ?? null,
      organizationLocation: input.organizationLocation ?? null,
      organizationWebsite: input.organizationWebsite ?? null,
      organizationDescription: input.organizationDescription ?? null,
      organizationPhone: input.organizationPhone ?? null,
      organizationLogo: input.organizationLogo ?? null,
    },
  });

  const organization = await tx.organization.create({
    data: {
      name: input.organizationName,
      anchorAccountId: account.id,
    },
  });

  await tx.orgMember.create({
    data: {
      organizationId: organization.id,
      accountId: account.id,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
  });

  return { account, profile, organization };
}

/**
 * Throws a 400 AppError if an account already exists for this email. Run this
 * BEFORE opening the transaction so a duplicate is a clean client error, not
 * a P2002 mid-transaction that aborts a partially-built onboarding commit.
 */
export async function assertEmailAvailable(
  email: string,
  client: PrismaTxClient = prisma as unknown as PrismaTxClient,
): Promise<void> {
  const existing = await client.account.findFirst({ where: { email } });
  if (existing) {
    throw new AppError('An account with this email already exists', 400);
  }
}

/**
 * Standalone org creation (the non-AI POST /organization path): a single
 * transaction wrapping createOrgAccount. Returns the created account + profile.
 */
export async function createOrganizationStandalone(input: CreateOrgAccountInput) {
  await assertEmailAvailable(input.email);
  return prisma.$transaction(async (tx) => {
    const { account, profile, organization } = await createOrgAccount(
      tx as unknown as PrismaTxClient,
      input,
    );
    return { account, profile, organization };
  });
}

export type CreateOrgAccountResult = Prisma.PromiseReturnType<typeof createOrganizationStandalone>;
