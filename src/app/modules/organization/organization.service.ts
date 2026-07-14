import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import crypto from 'node:crypto';
import { Request } from 'express';
import { configs } from '../../configs/index.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { orgInviteEmailQueue } from '../../queues/email/org-invite/org-invite.email.queue.js';
import { AppError } from '../../utils/app_error.js';
import { jwtHelpers, JwtPayloadType } from '../../utils/JWT.js';
import {
  findActiveMembership,
  recordOrgAuditEvent as recordAuditEvent,
} from '../../utils/org_scope.js';

// New-account password minimum, enforced here (not in the zod schema) since
// this same `password` field also authenticates an *existing* account's
// already-stored password in the other accept_invitation_into_db branch,
// where a min-length check would reject a legitimately correct password
// for any account created before an 8-char minimum existed. Found by
// independent review.
const NEW_ACCOUNT_PASSWORD_MIN_LENGTH = 8;

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
  const membership = await findActiveMembership(accountId);
  if (!membership) {
    throw new AppError('You are not a member of any organization.', 403);
  }
  if (membership.role !== 'ADMIN') {
    throw new AppError('Only organization admins can manage invitations.', 403);
  }
  return membership;
};

/**
 * Enqueues the org-invite email and turns a failure into a typed 502
 * instead of letting a raw queue/Redis error bubble up, or — worse —
 * silently returning a 200 to the admin while the invitee never gets an
 * email. The DB write (invitation created/refreshed) and this enqueue call
 * are still two separate steps with no shared transaction (BullMQ can't
 * join a Postgres transaction), so a process crash in the narrow window
 * between them is still possible and would strand the invitation exactly
 * as before — this only closes the far more common failure mode, an
 * enqueue-time exception (Redis unreachable, validation error), by making
 * it visible instead of swallowed. Same residual gap the OTP/reset-password
 * queues already have. Found by independent review.
 */
const enqueueInviteEmailOrThrow = async (params: {
  email: string;
  organizationName: string;
  inviteLink: string;
}) => {
  try {
    await orgInviteEmailQueue.add('org-invite-email-queue', params);
  } catch (err) {
    logger.error({ err, email: params.email }, 'Failed to enqueue org-invite email');
    throw new AppError(
      'The invitation was saved, but sending the email failed. Please try resending it.',
      502,
    );
  }
};

const invite_member_into_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const payload: { email: string; role: 'ADMIN' | 'LEAD_AUDITOR' | 'LIGHT_USER' | 'VIEWER' } =
    req?.body;
  // Normalized once, used everywhere below (lookup, create/update, email
  // send) — accept_invitation_into_db already matches Account.email
  // case-insensitively, but OrgInvitation.email itself (and the partial
  // unique index backing "one PENDING invite per org+email") was plain
  // case-sensitive text. Without normalizing here, inviting
  // 'Jane@Company.com' then 'jane@company.com' for the same org created two
  // separate PENDING rows with two different tokens instead of the intended
  // refresh-existing behavior. Found by independent review.
  const email = payload.email.trim().toLowerCase();

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
  //
  // Neither of these two reads depends on the other's result — both only
  // need callerMembership.organizationId — so they run concurrently instead
  // of adding two serial round trips to every invite call.
  const [existing, organization] = await Promise.all([
    prisma.orgInvitation.findFirst({
      where: {
        organizationId: callerMembership.organizationId,
        email,
        status: 'PENDING',
      },
    }),
    prisma.organization.findUniqueOrThrow({
      where: { id: callerMembership.organizationId },
      select: { name: true },
    }),
  ]);

  // The findFirst-then-create/update above is still a check-then-act: two
  // concurrent invites for the same (org, email) can both miss each other's
  // row and both attempt to create. A partial unique index on
  // (organizationId, email) WHERE status = 'PENDING' (see migration
  // 20260714030634) backs this at the DB level so the loser gets a clean
  // conflict instead of a duplicate PENDING row. Found by independent
  // review.
  let invitation;
  try {
    invitation = existing
      ? await prisma.orgInvitation.update({
          where: { id: existing.id },
          data: { role: payload.role, token, expiresAt },
        })
      : await prisma.orgInvitation.create({
          data: {
            organizationId: callerMembership.organizationId,
            email,
            role: payload.role,
            invitedById: user.accountId,
            token,
            expiresAt,
          },
        });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(
        'An invitation for this email is already pending — please try again.',
        409,
      );
    }
    throw err;
  }

  // Recorded before the email enqueue, not after: the invitation row above
  // is already committed at this point, so the audit event should reflect
  // that immediately. Recording it after enqueueInviteEmailOrThrow would
  // mean a transient enqueue failure (502) drops this event entirely — and
  // if the admin retries per the error message, the retry takes the
  // `existing` branch, logging MEMBER_INVITE_RESENT instead of the true
  // MEMBER_INVITED, mislabeling the actual creation event. Found by
  // independent review.
  await recordAuditEvent({
    organizationId: callerMembership.organizationId,
    action: existing ? 'MEMBER_INVITE_RESENT' : 'MEMBER_INVITED',
    actorAccountId: user.accountId,
    subjectEmail: invitation.email,
    metadata: { role: invitation.role, invitationId: invitation.id },
  });

  await enqueueInviteEmailOrThrow({
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

  // `status` alone stays ACTIVE indefinitely past a lapsed `expiresAt` —
  // isMembershipActive (org_scope.ts) already denies these at the API-auth
  // layer, but this list is what an admin or compliance export actually
  // reads to answer "who currently has access." Without a derived field,
  // that view silently lies: a time-boxed member who expired weeks ago
  // still shows as plain "ACTIVE." Deliberately NOT written back to the
  // `status` column itself — collapsing "expired" into the same SUSPENDED
  // value used for explicit offboarding would erase the distinction between
  // "this org revoked access" and "this person's time-boxed window lapsed
  // on its own," which matters for exactly the same audit questions this
  // fixes. Found by independent review.
  return members.map((member) => ({
    ...member,
    isExpired: !!member.expiresAt && member.expiresAt.getTime() < Date.now(),
  }));
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

  const data: { status?: 'ACTIVE' | 'SUSPENDED'; expiresAt?: Date | null } = {};
  if (payload.status !== undefined) data.status = payload.status;
  if (payload.expiresAt !== undefined) data.expiresAt = payload.expiresAt;

  // The last-admin check-then-act and the update itself are wrapped in one
  // Serializable transaction: two concurrent requests each deactivating a
  // *different* one of the org's last two admins could otherwise both read
  // "1 other active admin" (each other) before either write commits, and
  // both proceed — leaving zero active admins despite the guard. Under
  // Serializable isolation, Postgres detects that overlap and aborts the
  // loser with a serialization failure instead of letting both through.
  // Also fixed here: the count now excludes admins whose time-boxed access
  // has already lapsed (status still ACTIVE, expiresAt in the past) — the
  // original check treated such a row as a valid "other admin", which could
  // let the *real* last admin be deactivated even though the "other" one
  // can no longer authenticate at all (resolveCallerOrgContext already
  // hard-denies an expired membership). Both found by independent review.
  const updated = await prisma
    .$transaction(
      async (tx) => {
        if (member.role === 'ADMIN' && member.status === 'ACTIVE' && isDeactivating) {
          const otherActiveAdmins = await tx.orgMember.count({
            where: {
              organizationId: callerMembership.organizationId,
              role: 'ADMIN',
              status: 'ACTIVE',
              id: { not: member.id },
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
          });
          if (otherActiveAdmins === 0) {
            throw new AppError(
              'Cannot deactivate the last active admin — the organization would have no one left to manage it.',
              409,
            );
          }
        }

        return tx.orgMember.update({
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
    .catch((err) => {
      if (err instanceof AppError) throw err;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
        throw new AppError(
          'This change conflicted with another update to the same organization — please try again.',
          409,
        );
      }
      throw err;
    });

  await recordAuditEvent({
    organizationId: callerMembership.organizationId,
    action: payload.status !== undefined ? 'MEMBER_STATUS_CHANGED' : 'MEMBER_EXPIRY_CHANGED',
    actorAccountId: user.accountId,
    subjectOrgMemberId: member.id,
    subjectEmail: updated.account.email,
    metadata: {
      before: { status: member.status, expiresAt: member.expiresAt },
      after: { status: updated.status, expiresAt: updated.expiresAt },
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
  const [updated, organization] = await Promise.all([
    prisma.orgInvitation.update({
      where: { id: invitation.id },
      data: { token, expiresAt },
    }),
    prisma.organization.findUniqueOrThrow({
      where: { id: callerMembership.organizationId },
      select: { name: true },
    }),
  ]);

  // Recorded before the email enqueue — see the matching comment in
  // invite_member_into_db for why (the token rotation above is already
  // committed, so a transient enqueue failure shouldn't drop this event).
  await recordAuditEvent({
    organizationId: callerMembership.organizationId,
    action: 'MEMBER_INVITE_RESENT',
    actorAccountId: user.accountId,
    subjectEmail: updated.email,
    metadata: { invitationId: updated.id },
  });

  await enqueueInviteEmailOrThrow({
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

    await recordAuditEvent({
      organizationId: invitation.organizationId,
      action: 'MEMBER_INVITE_ACCEPTED',
      subjectEmail: existingAccount.email,
      metadata: { invitationId: invitation.id, isNewAccount: false },
    });

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

  // Only enforced here, not in the zod schema — see the schema-side comment
  // on organization_validations.accept_invitation for why. This is the
  // branch that's actually choosing a brand-new password.
  if (payload.password.length < NEW_ACCOUNT_PASSWORD_MIN_LENGTH) {
    throw new AppError(
      `Password must be at least ${NEW_ACCOUNT_PASSWORD_MIN_LENGTH} characters.`,
      400,
    );
  }

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

  await recordAuditEvent({
    organizationId: invitation.organizationId,
    action: 'MEMBER_INVITE_ACCEPTED',
    subjectEmail: invitation.email,
    metadata: { invitationId: invitation.id, isNewAccount: true },
  });

  const accessToken = jwtHelpers.generateAccessToken({
    email: invitation.email,
    role: 'ORGANIZATION',
    accountId: newAccountId,
  });

  return { accessToken, accountId: newAccountId, isNewAccount: true };
};

/**
 * Admin-only. Exposes requireApprovalForSubAssignment (the slice 4 toggle:
 * whether a Lead Auditor's finding sub-assignment needs an Admin's sign-off
 * before the assignee gets access — see action.service.ts's
 * assign_light_user_to_action) and leadAuditorRoleLabel (the configurable
 * display name for the Lead Auditor role — the OrgRole enum value itself
 * stays fixed, only the label shown to users is customizable).
 */
const get_organization_settings_from_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const callerMembership = await requireCallerIsOrgAdmin(user?.accountId);

  return prisma.organization.findUniqueOrThrow({
    where: { id: callerMembership.organizationId },
    select: {
      id: true,
      name: true,
      requireApprovalForSubAssignment: true,
      leadAuditorRoleLabel: true,
    },
  });
};

const update_organization_settings_in_db = async (req: Request) => {
  const user = req?.user as JwtPayloadType;
  const payload: { requireApprovalForSubAssignment?: boolean; leadAuditorRoleLabel?: string } =
    req?.body;
  const callerMembership = await requireCallerIsOrgAdmin(user?.accountId);

  const before = await prisma.organization.findUniqueOrThrow({
    where: { id: callerMembership.organizationId },
    select: { requireApprovalForSubAssignment: true, leadAuditorRoleLabel: true },
  });

  const updated = await prisma.organization.update({
    where: { id: callerMembership.organizationId },
    data: {
      ...(payload.requireApprovalForSubAssignment !== undefined && {
        requireApprovalForSubAssignment: payload.requireApprovalForSubAssignment,
      }),
      ...(payload.leadAuditorRoleLabel !== undefined && {
        leadAuditorRoleLabel: payload.leadAuditorRoleLabel,
      }),
    },
    select: {
      id: true,
      name: true,
      requireApprovalForSubAssignment: true,
      leadAuditorRoleLabel: true,
    },
  });

  await recordAuditEvent({
    organizationId: callerMembership.organizationId,
    action: 'ORG_SETTINGS_CHANGED',
    actorAccountId: user.accountId,
    metadata: {
      before: {
        requireApprovalForSubAssignment: before.requireApprovalForSubAssignment,
        leadAuditorRoleLabel: before.leadAuditorRoleLabel,
      },
      after: {
        requireApprovalForSubAssignment: updated.requireApprovalForSubAssignment,
        leadAuditorRoleLabel: updated.leadAuditorRoleLabel,
      },
    },
  });

  return updated;
};

export const organization_services = {
  invite_member_into_db,
  get_pending_invitations_from_db,
  get_org_members_from_db,
  update_org_member_in_db,
  resend_invitation_from_db,
  accept_invitation_into_db,
  get_organization_settings_from_db,
  update_organization_settings_in_db,
};
