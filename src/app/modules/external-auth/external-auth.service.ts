import bcrypt from 'bcrypt';
import { Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { jwtHelpers } from '../../utils/JWT.js';
import { AppError } from '../../utils/app_error.js';
import { numericVerificationCodeGenerator } from '../../utils/otpGenerator.js';
import { isExternalMembershipActive, recordOrgAuditEvent } from '../../utils/org_scope.js';
import { externalVerificationEmailQueue } from '../../queues/email/external-verification/external-verification.email.queue.js';

const CODE_EXPIRY_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// Same message regardless of whether the (organizationId, email) pair is a
// real, active external member — distinguishing "no such member" from
// "member exists but is suspended/expired" from "wrong code" would let a
// caller enumerate valid external-member emails per org one guess at a time.
const GENERIC_AUTH_ERROR = 'Invalid code, or your access is not active.';

const DUMMY_CODE = 'not-a-real-code';
// Precomputed once at module load — used as the bcrypt.compareSync target
// whenever there's no real code hash to compare against (no live member, no
// live code row, or a locked-out row). Without this, verify_code_and_login's
// response time for those cases would be measurably faster than the
// wrong-code path (which does a real bcrypt compare), turning latency itself
// into the same enumeration oracle the shared GENERIC_AUTH_ERROR message and
// uniform 401 status are meant to close. Found by independent review.
const DUMMY_CODE_HASH = bcrypt.hashSync(DUMMY_CODE, 10);

// A well-formed but never-real id used to key the verification-code lookup
// when there's no live member — see verify_code_and_login. Guarantees the
// query always runs (same DB round-trip count on every path) without ever
// matching a real ExternalOrgMemberVerificationCode row.
const DUMMY_MEMBER_ID = '00000000-0000-0000-0000-000000000000';

const request_verification_code_into_db = async (req: Request) => {
  const { organizationId, email } = req.body as { organizationId: string; email: string };
  const normalizedEmail = email.trim().toLowerCase();

  const member = await prisma.externalOrgMember.findUnique({
    where: { organizationId_email: { organizationId, email: normalizedEmail } },
    include: { organization: { select: { name: true } } },
  });

  const memberIsLive = !!member && isExternalMembershipActive(member);

  // Runs unconditionally — same DB-round-trip-count reasoning as
  // verify_code_and_login's liveCode query: skipping it for a non-member
  // would leave the real-member path one query more expensive, itself a
  // timing oracle. Found by independent review.
  //
  // A code row still under an active lockout is NOT invalidated/replaced —
  // otherwise an attacker who triggers the lockout could immediately request
  // a fresh code to reset failedAttempts/lockedUntil back to zero, making
  // the lockout mechanism trivially bypassable on demand (bounded only by
  // the separate IP/target rate limiters, not by the lockout itself). Found
  // by independent review.
  const priorLive = await prisma.externalOrgMemberVerificationCode.findFirst({
    where: {
      externalOrgMemberId: memberIsLive
        ? (member as NonNullable<typeof member>).id
        : DUMMY_MEMBER_ID,
      consumedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });

  // Always 200, even when there's no live member for this (org, email) pair,
  // or when a locked prior code exists — the request-code endpoint is
  // unauthenticated and public, so a differing response (404 vs 200) would
  // be an enumeration oracle for which emails are external members of a
  // given org. Also runs a dummy bcrypt hash on the no-member path so
  // response timing doesn't distinguish "no member" from "member exists" —
  // found by independent review, same reasoning as DUMMY_CODE_HASH below.
  //
  // NOT equalized beyond this point: a real, active, non-locked member
  // additionally costs a $transaction (2 writes) and a BullMQ enqueue call
  // that this early-return path has no equivalent for. Faking a write and a
  // queue publish on every request just to mask that residual timing gap
  // would add real complexity and its own failure modes (a dummy row to
  // clean up, a dummy job silently consuming worker capacity) for a
  // narrower, harder-to-exploit signal than the two oracles this function
  // already closes (response body/status, and the DB-read-count checked
  // above) — accepted as a known residual rather than chased further.
  if (!memberIsLive || (priorLive?.lockedUntil && priorLive.lockedUntil.getTime() > Date.now())) {
    bcrypt.hashSync(DUMMY_CODE, 10);
    return { message: 'If that email is registered, a code has been sent.' };
  }

  const code = numericVerificationCodeGenerator();
  const codeHash = bcrypt.hashSync(code, 10);

  await prisma.$transaction([
    // Invalidate any still-live prior code for this member before issuing a
    // new one — only the most recently requested code should ever be
    // guessable, otherwise a member who requests several codes in a row
    // leaves multiple valid codes/lockout-counters live at once. (A locked
    // prior code never reaches here — see the check above.)
    prisma.externalOrgMemberVerificationCode.updateMany({
      where: { externalOrgMemberId: member.id, consumedAt: null },
      data: { consumedAt: new Date() },
    }),
    prisma.externalOrgMemberVerificationCode.create({
      data: {
        externalOrgMemberId: member.id,
        codeHash,
        expiresAt: new Date(Date.now() + CODE_EXPIRY_MS),
      },
    }),
  ]);

  await externalVerificationEmailQueue.add('external-verification-email-queue', {
    email: normalizedEmail,
    code,
    organizationName: member.organization.name,
  });

  return { message: 'If that email is registered, a code has been sent.' };
};

const verify_code_and_login = async (req: Request) => {
  const { organizationId, email, code } = req.body as {
    organizationId: string;
    email: string;
    code: string;
  };
  const normalizedEmail = email.trim().toLowerCase();

  const member = await prisma.externalOrgMember.findUnique({
    where: { organizationId_email: { organizationId, email: normalizedEmail } },
  });
  const memberIsLive = !!member && isExternalMembershipActive(member);

  // Always runs this second query — even when there's no live member to key
  // it by — so every failure path costs the same number of DB round-trips.
  // Equalizing the bcrypt compare and the response status/message (below)
  // but skipping this query for a non-member left the real-member path one
  // round-trip more expensive than every other path, which is itself a
  // timing oracle distinguishing "real active member" from everyone else,
  // independent of and in addition to the bcrypt-cost oracle. Found by
  // independent review.
  const liveCode = await prisma.externalOrgMemberVerificationCode.findFirst({
    where: {
      externalOrgMemberId: memberIsLive
        ? (member as NonNullable<typeof member>).id
        : DUMMY_MEMBER_ID,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
  const isLocked = !!liveCode?.lockedUntil && liveCode.lockedUntil.getTime() > Date.now();

  // Always runs a bcrypt compare — against the real code hash when one
  // exists and isn't locked, otherwise against a fixed dummy hash — so
  // response timing can't distinguish "no such member", "no live code", and
  // "locked out" from an actual wrong-code guess. Every failure path below
  // returns the identical status (401) and message for the same reason: a
  // distinct 429 for the locked case (the original implementation) let the
  // HTTP status code itself prove a given (organizationId, email) pair is a
  // real, active member with a live code — status and timing are both part
  // of the oracle a "generic message" alone doesn't close. Found by
  // independent review.
  const isMatch = bcrypt.compareSync(
    code,
    liveCode && !isLocked ? liveCode.codeHash : DUMMY_CODE_HASH,
  );

  if (!memberIsLive || !liveCode || isLocked || !isMatch) {
    if (liveCode && !isLocked && !isMatch) {
      // Atomic increment (not read-modify-write) — two concurrent verify
      // requests against the same code row must each land their own +1
      // rather than both computing the same "current + 1" from a stale read
      // and silently losing an increment, which would let an attacker get
      // more live guesses than MAX_FAILED_ATTEMPTS actually allows. Found by
      // independent review.
      const updated = await prisma.externalOrgMemberVerificationCode.update({
        where: { id: liveCode.id },
        data: { failedAttempts: { increment: 1 } },
        select: { failedAttempts: true },
      });
      if (updated.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        await prisma.externalOrgMemberVerificationCode.update({
          where: { id: liveCode.id },
          data: { lockedUntil: new Date(Date.now() + LOCKOUT_MS) },
        });
      }
    }
    throw new AppError(GENERIC_AUTH_ERROR, 401);
  }

  await prisma.externalOrgMemberVerificationCode.update({
    where: { id: liveCode.id },
    data: { consumedAt: new Date() },
  });

  // memberIsLive already guaranteed member is non-null (short-circuits the
  // throw above otherwise) — narrow once here for the remaining reads.
  const liveMember = member as NonNullable<typeof member>;

  const accessToken = jwtHelpers.generateExternalAccessToken({
    externalOrgMemberId: liveMember.id,
  });

  await recordOrgAuditEvent({
    organizationId,
    action: 'EXTERNAL_MEMBER_LOGIN_SUCCEEDED',
    subjectExternalOrgMemberId: liveMember.id,
    subjectEmail: normalizedEmail,
  });

  return {
    accessToken,
    externalOrgMemberId: liveMember.id,
    email: liveMember.email,
    fullName: liveMember.fullName,
  };
};

export const external_auth_services = {
  request_verification_code_into_db,
  verify_code_and_login,
};
