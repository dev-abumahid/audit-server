import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import crypto from 'node:crypto';
import { Request } from 'express';
import { configs } from '../../configs/index.js';
import { prisma } from '../../lib/prisma.js';
import { orgInviteEmailQueue } from '../../queues/email/org-invite/org-invite.email.queue.js';
import { AppError } from '../../utils/app_error.js';
import { jwtHelpers, JwtPayloadType } from '../../utils/JWT.js';
import { isMembershipActive } from '../../utils/org_scope.js';

// Named constant, not a magic number — invitations are valid for this long
// after being (re)sent.
const INVITATION_EXPIRY_DAYS = 7;
const INVITATION_EXPIRY_MS = INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

const buildInviteLink = (token: string) => `${configs.jwt.front_end_url}/invite/${token}/accept`;

/**
 * accept_invitation_into_db does a check-then-act read of OrgMember.accountId
 * (unique) and Account.email (unique) before its transaction, so a
 * concurrent accept (double-click, retried request) can still race past that
 * check and hit the DB constraint inside the transaction. Without this, that
 * shows up as a raw, uncaught PrismaClientKnownRequestError (P2002) — a
 * generic 500 — instead of the same clean AppError the non-race path
 * already returns for the identical logical conflict.
 */
const runAcceptTransactionOrConflict = async <T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  conflictMessage: string,
): Promise<T> => {
  try {
    return await prisma.$transaction(fn);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(conflictMessage, 409);
    }
    throw err;
  }
};

/**
 * Resolves the caller's own org membership and enforces that it's an ADMIN
 * row. Slice 3 owns building out full role-gating middleware/infra — this is
 * a local, single-purpose check just for the invite-management endpoints so
 * this slice doesn't ship without *any* gating. A caller with no OrgMember
 * row at all (shouldn't happen post-slice-1-backfill, but defensively
 * handled) is rejected the same way: they don't belong to an org, so there's
 * nothing for them to invite into.
 *
 * Also enforces status/expiresAt via the shared isMembershipActive predicate
 * (org_scope.ts) — the same one resolveCallerOrgContext uses. Without this,
 * a SUSPENDED (or time-boxed-expired) admin could keep calling every
 * endpoint in this file, including update_org_member_in_db, letting them
 * re-suspend whoever suspended them or suspend every other admin in the
 * org — the one endpoint whose entire purpose is revoking admin access
 * wouldn't actually revoke it. Found by independent review, and the check
 * was originally duplicated here rather than shared — which is exactly how
 * it almost drifted out of sync with org_scope.ts's version. Sharing the
 * predicate (not just the intent) is the actual fix for that class of bug.
 */
const requireCallerIsOrgAdmin = async (accountId: string) => {
  const membership = await prisma.orgMember.findUnique({
    where: { accountId },
  });
  if (!membership) {
    throw new AppError('You are not a member of any organization.', 403);
  }
  if (!isMembershipActive(membership)) {
    throw new AppError('Your access to this organization is no longer active.', 403);
  }
  if (membership.role !== 'ADMIN') {
    throw new AppError('Only organization admins can manage invitations.', 403);
  }
  return membership;
};

const invite_member_into_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const payload: { email: string; role: 'ADMIN' | 'LEAD_AUDITOR' | 'LIGHT_USER' | 'VIEWER' } =
    req?.body;

  // Org scoping: the invite always targets the caller's own org — there is
  // no way to pass an organizationId in the body, which is deliberate.
  const callerMembership = await requireCallerIsOrgAdmin(user?.accountId);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS);

  // If a PENDING invitation already exists for this email in this org, we
  // refresh it (new token + expiry, updated role) and resend rather than
  // rejecting. Rationale: an admin re-inviting the same email is almost
  // always trying to fix a typo'd role or nudge someone who missed the
  // first email, not creating a duplicate on purpose. Refreshing also
  // invalidates the old token, so a stale/leaked previous invite link stops
  // working. `POST /invite/:id/resend` is a thin wrapper around the same
  // "extend + re-send" behavior for an admin working from an invitations
  // list instead of re-typing the email.
  const existing = await prisma.orgInvitation.findFirst({
    where: {
      organizationId: callerMembership.organizationId,
      email: payload.email,
      status: 'PENDING',
    },
  });

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: callerMembership.organizationId },
    select: { name: true },
  });

  const invitation = existing
    ? await prisma.orgInvitation.update({
        where: { id: existing.id },
        data: { role: payload.role, token, expiresAt },
      })
    : await prisma.orgInvitation.create({
        data: {
          organizationId: callerMembership.organizationId,
          email: payload.email,
          role: payload.role,
          invitedById: user.accountId,
          token,
          expiresAt,
        },
      });

  await orgInviteEmailQueue.add('org-invite-email-queue', {
    email: invitation.email,
    organizationName: organization.name,
    inviteLink: buildInviteLink(token),
  });

  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
  };
};

const get_pending_invitations_from_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const callerMembership = await requireCallerIsOrgAdmin(user?.accountId);

  const invitations = await prisma.orgInvitation.findMany({
    where: {
      organizationId: callerMembership.organizationId,
      status: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  return invitations;
};

/**
 * Admin-only. Lists the caller's org members with their OrgMember.id —
 * without this, there is no way for an admin to ever discover the
 * orgMemberId that inspection.service.ts's assign_member_to_inspection
 * requires, making that endpoint unreachable through the actual product
 * surface despite being correctly implemented and scoped. Found by
 * independent review tracing the real admin workflow (invite -> accept ->
 * assign) end to end rather than testing each endpoint in isolation.
 */
const get_org_members_from_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const callerMembership = await requireCallerIsOrgAdmin(user?.accountId);

  const members = await prisma.orgMember.findMany({
    where: { organizationId: callerMembership.organizationId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      role: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      account: {
        select: {
          email: true,
          profile: { select: { fullName: true } },
        },
      },
    },
  });

  return members;
};

/**
 * Admin-only. Updates an existing OrgMember's status and/or expiresAt —
 * the only way to offboard (SUSPENDED) or time-box (expiresAt) a member.
 * Both fields are hard-denied in resolveCallerOrgContext (org_scope.ts) once
 * set, but until this endpoint existed nothing in the real API could ever
 * set them: every OrgMember created via accept_invitation_into_db is always
 * `status: 'ACTIVE'`, `expiresAt: null`, permanently.
 */
const update_org_member_in_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const memberId = req?.params?.id as string;
  const payload: { status?: 'ACTIVE' | 'SUSPENDED'; expiresAt?: Date | null } = req?.body;
  const callerMembership = await requireCallerIsOrgAdmin(user?.accountId);

  // Org-scoped lookup: an admin can only update members that belong to their
  // own org, never by guessing another org's OrgMember id.
  const member = await prisma.orgMember.findFirst({
    where: { id: memberId, organizationId: callerMembership.organizationId },
  });
  if (!member) {
    throw new AppError('Organization member not found.', 404);
  }

  // Block self-service suspension/expiry: resolveCallerOrgContext hard-denies
  // a SUSPENDED or expired caller with no fallback, so a sole admin doing
  // this to themselves would be a permanent lockout with no other API path
  // to undo it.
  if (member.accountId === user.accountId) {
    throw new AppError('You cannot change the status of your own membership.', 403);
  }

  // Same lockout risk, one step removed: the self-check above only stops an
  // admin from suspending themselves, not from suspending every OTHER admin
  // down to zero. If that admin then loses access too (leaves, gets
  // compromised, whatever), the org has no active admin left and — since
  // this endpoint itself requires an ACTIVE admin caller — no API path to
  // ever reactivate anyone. Found by independent review.
  const isDeactivating =
    payload.status === 'SUSPENDED' ||
    (payload.expiresAt !== undefined &&
      payload.expiresAt !== null &&
      payload.expiresAt.getTime() <= Date.now());
  if (member.role === 'ADMIN' && member.status === 'ACTIVE' && isDeactivating) {
    const otherActiveAdmins = await prisma.orgMember.count({
      where: {
        organizationId: callerMembership.organizationId,
        role: 'ADMIN',
        status: 'ACTIVE',
        id: { not: member.id },
      },
    });
    if (otherActiveAdmins === 0) {
      throw new AppError(
        'Cannot deactivate the last active admin — the organization would have no one left to manage it.',
        409,
      );
    }
  }

  const data: { status?: 'ACTIVE' | 'SUSPENDED'; expiresAt?: Date | null } = {};
  if (payload.status !== undefined) data.status = payload.status;
  if (payload.expiresAt !== undefined) data.expiresAt = payload.expiresAt;

  const updated = await prisma.orgMember.update({
    where: { id: member.id },
    data,
    select: {
      id: true,
      role: true,
      status: true,
      expiresAt: true,
      account: {
        select: {
          email: true,
          profile: { select: { fullName: true } },
        },
      },
    },
  });

  return updated;
};

const resend_invitation_from_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const invitationId = req?.params?.id as string;
  const callerMembership = await requireCallerIsOrgAdmin(user?.accountId);

  // Org-scoped lookup: an admin can only resend invitations that belong to
  // their own org, never by guessing another org's invitation id.
  const invitation = await prisma.orgInvitation.findFirst({
    where: { id: invitationId, organizationId: callerMembership.organizationId },
  });
  if (!invitation) {
    throw new AppError('Invitation not found.', 404);
  }
  if (invitation.status !== 'PENDING') {
    throw new AppError('Only pending invitations can be resent.', 400);
  }

  // Rotate the token, not just the expiry — this is what actually
  // invalidates a stale/leaked previous invite link, matching the same
  // "extend + re-send" behavior invite_member_into_db's refresh branch
  // already does, and what this function's own callers document expecting
  // (see the design note on invite_member_into_db). Previously this only
  // extended expiresAt, so a resend left the OLD link (and OLD token) still
  // fully valid — the exact opposite of the documented intent.
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS);
  const updated = await prisma.orgInvitation.update({
    where: { id: invitation.id },
    data: { token, expiresAt },
  });

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: callerMembership.organizationId },
    select: { name: true },
  });

  await orgInviteEmailQueue.add('org-invite-email-queue', {
    email: updated.email,
    organizationName: organization.name,
    inviteLink: buildInviteLink(updated.token),
  });

  return {
    id: updated.id,
    email: updated.email,
    role: updated.role,
    status: updated.status,
    expiresAt: updated.expiresAt,
  };
};

/**
 * Accept flow design decision (see PR description for the full write-up):
 *
 * A single public endpoint handles both "invited email already has an
 * Account" and "invited email is brand new" in one request, distinguished
 * by whether `prisma.account.findUnique({ where: { email: invitation.email
 * } })` finds a row — NOT by a client-supplied flag, so the client can't lie
 * about which case it is.
 *
 *   - Existing account: the request body's `password` is checked against
 *     the account's stored password hash. This authenticates the accepter
 *     without requiring them to separately log in and carry a JWT into this
 *     public endpoint first — simplest correct option, and it mirrors how
 *     `login_user_into_db` already authenticates by credentials.
 *   - New account: `password` + `fullName` create the Account + Profile +
 *     OrgMember atomically. The account is marked `isAccountVerified: true`
 *     immediately, skipping the normal signup OTP step — receiving and
 *     clicking a link sent to that exact email address is itself proof of
 *     email ownership, so re-verifying via OTP would be redundant friction
 *     for an invited teammate.
 *
 * Either branch ends with an accessToken so the client can drop the
 * accepter straight into an authenticated session, same shape as
 * `login_user_into_db`'s return value.
 */
const accept_invitation_into_db = async (req: Request) => {
  const payload: { token: string; password: string; fullName?: string } = req?.body;
  const token = payload.token;

  const invitation = await prisma.orgInvitation.findUnique({ where: { token } });
  if (!invitation) {
    throw new AppError('Invalid invitation link.', 404);
  }
  if (invitation.status === 'ACCEPTED') {
    throw new AppError('This invitation has already been accepted.', 400);
  }
  if (invitation.status === 'EXPIRED' || invitation.expiresAt.getTime() < Date.now()) {
    if (invitation.status !== 'EXPIRED') {
      await prisma.orgInvitation.update({
        where: { id: invitation.id },
        data: { status: 'EXPIRED' },
      });
    }
    throw new AppError('This invitation has expired.', 400);
  }

  // Case-insensitive: findUnique can't do mode: 'insensitive' on a unique
  // field, so this uses findFirst instead. Without this, inviting
  // 'Jane@Company.com' when Jane actually signed up as 'jane@company.com'
  // (no email normalization anywhere in the signup/invite pipeline) would
  // miss the existing account and fall into the brand-new-account branch,
  // creating a second Account with the same email in different case and
  // bypassing the one-account-one-org check below. Found by independent
  // review.
  const existingAccount = await prisma.account.findFirst({
    where: { email: { equals: invitation.email, mode: 'insensitive' } },
    include: { orgMembership: true },
  });

  if (existingAccount) {
    // One-account-one-org rule: reject clearly rather than let the
    // OrgMember.accountId unique constraint throw an opaque DB error.
    if (existingAccount.orgMembership) {
      if (existingAccount.orgMembership.organizationId === invitation.organizationId) {
        throw new AppError('You are already a member of this organization.', 409);
      }
      throw new AppError(
        'This account already belongs to a different organization and cannot join another.',
        409,
      );
    }

    // Mirror login_user_into_db's guards (account.service.ts) exactly —
    // this branch authenticates an existing account by password just like
    // login does, so it needs the same provider/deleted/verified checks or
    // it silently authenticates accounts login would reject.
    if (existingAccount.provider !== 'LOCAL') {
      throw new AppError(
        `This email is already registered via ${existingAccount.provider}. Sign in with that method, then ask an admin to add you to the organization.`,
        400,
      );
    }
    if (existingAccount.isDeleted) {
      throw new AppError('This account has been deleted.', 401);
    }
    if (!existingAccount.isAccountVerified) {
      throw new AppError('Please verify your account before accepting this invitation.', 401);
    }

    const isPasswordMatch = bcrypt.compareSync(
      payload.password,
      existingAccount.password as string,
    );
    if (!isPasswordMatch) {
      throw new AppError('Incorrect password.', 401);
    }

    await runAcceptTransactionOrConflict(async (tx) => {
      await tx.orgMember.create({
        data: {
          organizationId: invitation.organizationId,
          accountId: existingAccount.id,
          role: invitation.role,
          status: 'ACTIVE',
        },
      });
      await tx.orgInvitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });
    }, 'This account already belongs to a different organization and cannot join another.');

    const accessToken = jwtHelpers.generateAccessToken({
      email: existingAccount.email,
      role: existingAccount.role,
      accountId: existingAccount.id,
    });

    return { accessToken, accountId: existingAccount.id, isNewAccount: false };
  }

  if (!payload.fullName) {
    throw new AppError('Full name is required to create your account.', 400);
  }
  const fullName = payload.fullName;

  const hashPassword = bcrypt.hashSync(payload.password, 10);

  // login_user_into_db reads Account.organizationProfile.organizationName
  // for every login response — without creating this row, an invited
  // member's organizationName would come back undefined on every login
  // after acceptance, unlike a self-signed-up account (account.service.ts
  // creates this row at signup time). Reuse the real org's name so an
  // invited teammate's login response matches what their org is actually
  // called, not a placeholder.
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: invitation.organizationId },
    select: { name: true },
  });

  const newAccountId = await runAcceptTransactionOrConflict(async (tx) => {
    const account = await tx.account.create({
      data: {
        email: invitation.email,
        password: hashPassword,
        role: 'ORGANIZATION',
        isAccountVerified: true,
      },
    });

    await tx.profile.create({
      data: {
        accountId: account.id,
        fullName,
      },
    });

    await tx.organizationProfile.create({
      data: {
        accountId: account.id,
        organizationName: organization.name,
      },
    });

    await tx.orgMember.create({
      data: {
        organizationId: invitation.organizationId,
        accountId: account.id,
        role: invitation.role,
        status: 'ACTIVE',
      },
    });

    await tx.orgInvitation.update({
      where: { id: invitation.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });

    return account.id;
  }, 'This invitation has already been accepted or the account already exists.');

  const accessToken = jwtHelpers.generateAccessToken({
    email: invitation.email,
    role: 'ORGANIZATION',
    accountId: newAccountId,
  });

  return { accessToken, accountId: newAccountId, isNewAccount: true };
};

export const organization_services = {
  invite_member_into_db,
  get_pending_invitations_from_db,
  get_org_members_from_db,
  update_org_member_in_db,
  resend_invitation_from_db,
  accept_invitation_into_db,
};
