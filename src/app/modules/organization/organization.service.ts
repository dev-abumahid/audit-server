import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { Request } from 'express';
import { configs } from '../../configs/index.js';
import { prisma } from '../../lib/prisma.js';
import { orgInviteEmailQueue } from '../../queues/email/org-invite/org-invite.email.queue.js';
import { AppError } from '../../utils/app_error.js';
import { jwtHelpers, JwtPayloadType } from '../../utils/JWT.js';

// Named constant, not a magic number — invitations are valid for this long
// after being (re)sent.
const INVITATION_EXPIRY_DAYS = 7;
const INVITATION_EXPIRY_MS = INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

const buildInviteLink = (token: string) => `${configs.jwt.front_end_url}/invite/${token}/accept`;

/**
 * Resolves the caller's own org membership and enforces that it's an ADMIN
 * row. Slice 3 owns building out full role-gating middleware/infra — this is
 * a local, single-purpose check just for the invite-management endpoints so
 * this slice doesn't ship without *any* gating. A caller with no OrgMember
 * row at all (shouldn't happen post-slice-1-backfill, but defensively
 * handled) is rejected the same way: they don't belong to an org, so there's
 * nothing for them to invite into.
 */
const requireCallerIsOrgAdmin = async (accountId: string) => {
  const membership = await prisma.orgMember.findUnique({
    where: { accountId },
  });
  if (!membership) {
    throw new AppError('You are not a member of any organization.', 403);
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

  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS);
  const updated = await prisma.orgInvitation.update({
    where: { id: invitation.id },
    data: { expiresAt },
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

  const existingAccount = await prisma.account.findUnique({
    where: { email: invitation.email },
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

    const isPasswordMatch = bcrypt.compareSync(
      payload.password,
      existingAccount.password as string,
    );
    if (!isPasswordMatch) {
      throw new AppError('Incorrect password.', 401);
    }

    await prisma.$transaction(async (tx: any) => {
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
    });

    const accessToken = jwtHelpers.generateToken(
      {
        email: existingAccount.email,
        role: existingAccount.role,
        accountId: existingAccount.id,
      },
      configs.jwt.access_token as string,
      configs.jwt.access_expires as string,
    );

    return { accessToken, accountId: existingAccount.id, isNewAccount: false };
  }

  if (!payload.fullName) {
    throw new AppError('Full name is required to create your account.', 400);
  }

  const hashPassword = bcrypt.hashSync(payload.password, 10);

  const newAccountId = await prisma.$transaction(async (tx: any) => {
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
        fullName: payload.fullName,
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
  });

  const accessToken = jwtHelpers.generateToken(
    {
      email: invitation.email,
      role: 'ORGANIZATION',
      accountId: newAccountId,
    },
    configs.jwt.access_token as string,
    configs.jwt.access_expires as string,
  );

  return { accessToken, accountId: newAccountId, isNewAccount: true };
};

export const organization_services = {
  invite_member_into_db,
  get_pending_invitations_from_db,
  resend_invitation_from_db,
  accept_invitation_into_db,
};
