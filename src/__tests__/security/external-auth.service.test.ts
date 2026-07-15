import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    externalOrgMember: {
      findUnique: vi.fn(),
    },
    externalOrgMemberVerificationCode: {
      updateMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    orgAuditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock(
  '../../app/queues/email/external-verification/external-verification.email.queue.js',
  () => ({
    externalVerificationEmailQueue: { add: vi.fn() },
  }),
);

import { prisma } from '../../app/lib/prisma.js';
import { externalVerificationEmailQueue } from '../../app/queues/email/external-verification/external-verification.email.queue.js';
import { external_auth_services } from '../../app/modules/external-auth/external-auth.service.js';

const memberDb = prisma.externalOrgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const codeDb = prisma.externalOrgMemberVerificationCode as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const auditDb = prisma.orgAuditLog as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
const mockQueueAdd = vi.mocked(externalVerificationEmailQueue.add);

const ORG_ID = 'org-1';
const MEMBER = {
  id: 'ext-1',
  organizationId: ORG_ID,
  email: 'external@test.com',
  fullName: 'Ext Person',
  role: 'LIGHT_USER',
  isActive: true,
  expiresAt: null,
  organization: { name: 'Acme' },
};

describe('external-auth service — request_verification_code_into_db (issue #55 slice 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation((ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
  });

  it('returns the generic message and does NOT enqueue an email when no member exists (anti-enumeration)', async () => {
    memberDb.findUnique.mockResolvedValue(null);
    codeDb.findFirst.mockResolvedValue(null);

    const result = await external_auth_services.request_verification_code_into_db(
      makeReq({ body: { organizationId: ORG_ID, email: 'nobody@test.com' } }),
    );

    expect(result.message).toMatch(/if that email is registered/i);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(codeDb.create).not.toHaveBeenCalled();
  });

  it('still runs the prior-code lookup when no member exists, so a real member does not cost one extra DB round-trip vs. a non-member (issue #55 slice 5 follow-up)', async () => {
    memberDb.findUnique.mockResolvedValue(null);
    codeDb.findFirst.mockResolvedValue(null);

    await external_auth_services.request_verification_code_into_db(
      makeReq({ body: { organizationId: ORG_ID, email: 'nobody@test.com' } }),
    );

    expect(codeDb.findFirst).toHaveBeenCalledTimes(1);
  });

  it('returns the same generic message and does NOT enqueue an email when the member is deactivated', async () => {
    memberDb.findUnique.mockResolvedValue({ ...MEMBER, isActive: false });

    const result = await external_auth_services.request_verification_code_into_db(
      makeReq({ body: { organizationId: ORG_ID, email: MEMBER.email } }),
    );

    expect(result.message).toMatch(/if that email is registered/i);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('invalidates any prior live code, creates a fresh one, and enqueues the email for a live member', async () => {
    memberDb.findUnique.mockResolvedValue(MEMBER);
    codeDb.findFirst.mockResolvedValue(null); // no prior live code -> no lockout to preserve
    codeDb.updateMany.mockResolvedValue({ count: 1 });
    codeDb.create.mockResolvedValue({ id: 'code-1' });

    await external_auth_services.request_verification_code_into_db(
      makeReq({ body: { organizationId: ORG_ID, email: '  External@Test.com  ' } }),
    );

    expect(codeDb.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { externalOrgMemberId: MEMBER.id, consumedAt: null },
        data: expect.objectContaining({ consumedAt: expect.any(Date) }),
      }),
    );
    expect(codeDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalOrgMemberId: MEMBER.id,
          codeHash: expect.any(String),
          expiresAt: expect.any(Date),
        }),
      }),
    );
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'external-verification-email-queue',
      expect.objectContaining({ email: MEMBER.email, organizationName: 'Acme' }),
    );
  });

  it('does NOT issue a new code (or reset the lockout) while a prior code for this member is still locked out (issue #55 slice 5 follow-up)', async () => {
    memberDb.findUnique.mockResolvedValue(MEMBER);
    codeDb.findFirst.mockResolvedValue({
      id: 'code-old',
      lockedUntil: new Date(Date.now() + 60000),
    });

    const result = await external_auth_services.request_verification_code_into_db(
      makeReq({ body: { organizationId: ORG_ID, email: MEMBER.email } }),
    );

    expect(result.message).toMatch(/if that email is registered/i);
    expect(codeDb.updateMany).not.toHaveBeenCalled();
    expect(codeDb.create).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('normalizes email to lowercase+trim before the member lookup', async () => {
    memberDb.findUnique.mockResolvedValue(null);

    await external_auth_services.request_verification_code_into_db(
      makeReq({ body: { organizationId: ORG_ID, email: '  External@Test.com  ' } }),
    );

    expect(memberDb.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_email: { organizationId: ORG_ID, email: 'external@test.com' } },
      }),
    );
  });
});

describe('external-auth service — verify_code_and_login (issue #55 slice 5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects with a generic 401 when no member exists', async () => {
    memberDb.findUnique.mockResolvedValue(null);
    codeDb.findFirst.mockResolvedValue(null);

    await expect(
      external_auth_services.verify_code_and_login(
        makeReq({ body: { organizationId: ORG_ID, email: 'nobody@test.com', code: '123456' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('still runs the verification-code lookup query when no member exists, so a real member does not cost one extra DB round-trip vs. a non-member (issue #55 slice 5 follow-up)', async () => {
    memberDb.findUnique.mockResolvedValue(null);
    codeDb.findFirst.mockResolvedValue(null);

    await expect(
      external_auth_services.verify_code_and_login(
        makeReq({ body: { organizationId: ORG_ID, email: 'nobody@test.com', code: '123456' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(codeDb.findFirst).toHaveBeenCalledTimes(1);
  });

  it('rejects with a generic 401 when the member is deactivated', async () => {
    memberDb.findUnique.mockResolvedValue({ ...MEMBER, isActive: false });

    await expect(
      external_auth_services.verify_code_and_login(
        makeReq({ body: { organizationId: ORG_ID, email: MEMBER.email, code: '123456' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects with a generic 401 when no live (unconsumed, unexpired) code exists', async () => {
    memberDb.findUnique.mockResolvedValue(MEMBER);
    codeDb.findFirst.mockResolvedValue(null);

    await expect(
      external_auth_services.verify_code_and_login(
        makeReq({ body: { organizationId: ORG_ID, email: MEMBER.email, code: '123456' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects with the same generic 401 (not a distinct status) when the code row is locked out — a distinct status is an enumeration oracle (issue #55 slice 5 follow-up)', async () => {
    memberDb.findUnique.mockResolvedValue(MEMBER);
    codeDb.findFirst.mockResolvedValue({
      id: 'code-1',
      codeHash: '$2b$10$whatever',
      failedAttempts: 5,
      lockedUntil: new Date(Date.now() + 60000),
    });

    await expect(
      external_auth_services.verify_code_and_login(
        makeReq({ body: { organizationId: ORG_ID, email: MEMBER.email, code: '123456' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 401, message: expect.stringMatching(/invalid code/i) });

    // Locked rows must not be re-attempted against — no increment write.
    expect(codeDb.update).not.toHaveBeenCalled();
  });

  it('atomically increments failedAttempts and rejects (401) on a wrong code (issue #55 slice 5 follow-up)', async () => {
    memberDb.findUnique.mockResolvedValue(MEMBER);
    codeDb.findFirst.mockResolvedValue({
      id: 'code-1',
      codeHash: '$2b$10$' + 'a'.repeat(53), // bcrypt.compareSync against a bogus hash -> false
      failedAttempts: 0,
      lockedUntil: null,
    });
    codeDb.update.mockResolvedValue({ failedAttempts: 1 });

    await expect(
      external_auth_services.verify_code_and_login(
        makeReq({ body: { organizationId: ORG_ID, email: MEMBER.email, code: '000000' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });

    // {increment: 1} not a read-modify-write literal — see the service's own
    // comment on why the previous read-then-write was a race.
    expect(codeDb.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
  });

  it('locks the code row once the atomic increment reaches the threshold', async () => {
    memberDb.findUnique.mockResolvedValue(MEMBER);
    codeDb.findFirst.mockResolvedValue({
      id: 'code-1',
      codeHash: '$2b$10$' + 'a'.repeat(53),
      failedAttempts: 4,
      lockedUntil: null,
    });
    codeDb.update.mockResolvedValueOnce({ failedAttempts: 5 }).mockResolvedValueOnce({});

    await expect(
      external_auth_services.verify_code_and_login(
        makeReq({ body: { organizationId: ORG_ID, email: MEMBER.email, code: '000000' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(codeDb.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'code-1' },
      data: { lockedUntil: expect.any(Date) },
    });
  });

  it('consumes the code, issues a token, and records an audit event on a correct code', async () => {
    const bcrypt = await import('bcrypt');
    const codeHash = bcrypt.hashSync('654321', 10);
    memberDb.findUnique.mockResolvedValue(MEMBER);
    codeDb.findFirst.mockResolvedValue({
      id: 'code-1',
      codeHash,
      failedAttempts: 0,
      lockedUntil: null,
    });
    codeDb.update.mockResolvedValue({});
    auditDb.create.mockResolvedValue({});

    const result = await external_auth_services.verify_code_and_login(
      makeReq({ body: { organizationId: ORG_ID, email: MEMBER.email, code: '654321' } }),
    );

    expect(codeDb.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { consumedAt: expect.any(Date) },
    });
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.externalOrgMemberId).toBe(MEMBER.id);
    expect(auditDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG_ID,
          action: 'EXTERNAL_MEMBER_LOGIN_SUCCEEDED',
          subjectExternalOrgMemberId: MEMBER.id,
        }),
      }),
    );
  });
});
