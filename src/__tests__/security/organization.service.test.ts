import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    orgMember: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    orgInvitation: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    organization: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    account: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    orgAuditLog: {
      create: vi.fn(),
    },
    externalOrgMember: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../app/queues/email/org-invite/org-invite.email.queue.js', () => ({
  orgInviteEmailQueue: { add: vi.fn() },
}));

import { prisma } from '../../app/lib/prisma.js';
import { orgInviteEmailQueue } from '../../app/queues/email/org-invite/org-invite.email.queue.js';
import { organization_services } from '../../app/modules/organization/organization.service.js';

const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgInvitationDb = prisma.orgInvitation as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const accountDb = prisma.account as unknown as Record<string, ReturnType<typeof vi.fn>>;
const externalOrgMemberDb = prisma.externalOrgMember as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const mockTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;
const mockQueueAdd = vi.mocked(orgInviteEmailQueue.add);

const ORG_1 = 'org-00000000-0000-0000-0000-000000000001';
const ORG_2 = 'org-00000000-0000-0000-0000-000000000002';

describe('organization service — invite creation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a PENDING invitation with a token and expiresAt roughly 7 days out', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgInvitationDb.findFirst.mockResolvedValue(null);
    organizationDb.findUniqueOrThrow.mockResolvedValue({ name: 'Acme' });
    orgInvitationDb.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'inv-1', status: 'PENDING', ...data }),
    );

    const result = await organization_services.invite_member_into_db(
      makeReq({
        user: { accountId: 'admin-1' },
        body: { email: 'newperson@test.com', role: 'LEAD_AUDITOR' },
      }),
    );

    expect(orgInvitationDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG_1,
          email: 'newperson@test.com',
          role: 'LEAD_AUDITOR',
          invitedById: 'admin-1',
          token: expect.any(String),
        }),
      }),
    );
    const createdData = orgInvitationDb.create.mock.calls[0][0].data;
    expect(createdData.token.length).toBeGreaterThanOrEqual(32);
    const daysOut = (createdData.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysOut).toBeGreaterThan(6.9);
    expect(daysOut).toBeLessThan(7.1);

    expect(result.status).toBe('PENDING');
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'org-invite-email-queue',
      expect.objectContaining({ email: 'newperson@test.com', organizationName: 'Acme' }),
    );
  });

  it('converts a concurrent invite-creation race (partial unique index violation) into a clean 409', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    // Neither admin's findFirst sees the other's in-flight invite — both
    // reach create(), and the DB's partial unique index on
    // (organizationId, email) WHERE status='PENDING' rejects the loser.
    orgInvitationDb.findFirst.mockResolvedValue(null);
    organizationDb.findUniqueOrThrow.mockResolvedValue({ name: 'Acme' });
    const { Prisma } = await import('@prisma/client');
    orgInvitationDb.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      organization_services.invite_member_into_db(
        makeReq({
          user: { accountId: 'admin-1' },
          body: { email: 'raced@test.com', role: 'VIEWER' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('refreshes an existing PENDING invitation instead of creating a duplicate', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgInvitationDb.findFirst.mockResolvedValue({
      id: 'inv-existing',
      organizationId: ORG_1,
      email: 'newperson@test.com',
      status: 'PENDING',
    });
    organizationDb.findUniqueOrThrow.mockResolvedValue({ name: 'Acme' });
    orgInvitationDb.update.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'inv-existing',
        email: 'newperson@test.com',
        status: 'PENDING',
        ...data,
      }),
    );

    await organization_services.invite_member_into_db(
      makeReq({
        user: { accountId: 'admin-1' },
        body: { email: 'newperson@test.com', role: 'VIEWER' },
      }),
    );

    expect(orgInvitationDb.create).not.toHaveBeenCalled();
    expect(orgInvitationDb.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv-existing' },
        data: expect.objectContaining({ role: 'VIEWER' }),
      }),
    );
  });

  it('rejects when the caller has no org membership at all', async () => {
    orgMemberDb.findUnique.mockResolvedValue(null);

    await expect(
      organization_services.invite_member_into_db(
        makeReq({
          user: { accountId: 'nobody' },
          body: { email: 'x@test.com', role: 'VIEWER' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(orgInvitationDb.create).not.toHaveBeenCalled();
  });

  it('rejects (org-scoping) when the caller is not an ADMIN of their org', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_2,
      accountId: 'member-1',
      role: 'LEAD_AUDITOR',
      status: 'ACTIVE',
      expiresAt: null,
    });

    await expect(
      organization_services.invite_member_into_db(
        makeReq({
          user: { accountId: 'member-1' },
          body: { email: 'x@test.com', role: 'VIEWER' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(orgInvitationDb.create).not.toHaveBeenCalled();
  });

  it('rejects a SUSPENDED admin — cannot keep managing the org after being suspended', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'SUSPENDED',
      expiresAt: null,
    });

    await expect(
      organization_services.invite_member_into_db(
        makeReq({
          user: { accountId: 'admin-1' },
          body: { email: 'x@test.com', role: 'VIEWER' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(orgInvitationDb.create).not.toHaveBeenCalled();
  });

  it('rejects an admin whose time-boxed access has expired', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 1000 * 60 * 60),
    });

    await expect(
      organization_services.invite_member_into_db(
        makeReq({
          user: { accountId: 'admin-1' },
          body: { email: 'x@test.com', role: 'VIEWER' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(orgInvitationDb.create).not.toHaveBeenCalled();
  });

  it('normalizes the invite email to lowercase and trimmed before lookup and creation (issue #55 follow-up)', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgInvitationDb.findFirst.mockResolvedValue(null);
    organizationDb.findUniqueOrThrow.mockResolvedValue({ name: 'Acme' });
    orgInvitationDb.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'inv-1', status: 'PENDING', ...data }),
    );

    await organization_services.invite_member_into_db(
      makeReq({
        user: { accountId: 'admin-1' },
        body: { email: '  Jane@Company.com  ', role: 'VIEWER' },
      }),
    );

    expect(orgInvitationDb.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ email: 'jane@company.com' }),
      }),
    );
    expect(orgInvitationDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'jane@company.com' }),
      }),
    );
  });

  it('treats differently-cased emails as the same pending invite and refreshes instead of duplicating (issue #55 follow-up)', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgInvitationDb.findFirst.mockResolvedValue({
      id: 'inv-existing',
      organizationId: ORG_1,
      email: 'jane@company.com',
      status: 'PENDING',
    });
    organizationDb.findUniqueOrThrow.mockResolvedValue({ name: 'Acme' });
    orgInvitationDb.update.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'inv-existing',
        email: 'jane@company.com',
        status: 'PENDING',
        ...data,
      }),
    );

    await organization_services.invite_member_into_db(
      makeReq({
        user: { accountId: 'admin-1' },
        body: { email: 'JANE@COMPANY.COM', role: 'VIEWER' },
      }),
    );

    expect(orgInvitationDb.create).not.toHaveBeenCalled();
    expect(orgInvitationDb.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'inv-existing' } }),
    );
  });
});

describe('organization service — invitation acceptance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the OrgMember and marks ACCEPTED for a valid, non-expired token (new account)', async () => {
    const futureExpiry = new Date(Date.now() + 1000 * 60 * 60);
    orgInvitationDb.findUnique.mockResolvedValue({
      id: 'inv-1',
      organizationId: ORG_1,
      email: 'brandnew@test.com',
      role: 'LEAD_AUDITOR',
      status: 'PENDING',
      expiresAt: futureExpiry,
      token: 'tok-1',
    });
    accountDb.findFirst.mockResolvedValue(null);
    organizationDb.findUniqueOrThrow.mockResolvedValue({ name: 'Acme' });

    const orgMemberCreate = vi.fn().mockResolvedValue({});
    const invitationUpdate = vi.fn().mockResolvedValue({});
    const accountCreate = vi.fn().mockResolvedValue({ id: 'new-acc-1' });
    const profileCreate = vi.fn().mockResolvedValue({});
    const organizationProfileCreate = vi.fn().mockResolvedValue({});
    mockTransaction.mockImplementation(async (fn) =>
      fn({
        account: { create: accountCreate },
        profile: { create: profileCreate },
        organizationProfile: { create: organizationProfileCreate },
        orgMember: { create: orgMemberCreate },
        orgInvitation: { update: invitationUpdate },
      }),
    );

    const result = await organization_services.accept_invitation_into_db(
      makeReq({
        body: { token: 'tok-1', password: 'a-decent-password', fullName: 'Brand New' },
      }),
    );

    expect(accountCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'brandnew@test.com', isAccountVerified: true }),
      }),
    );
    expect(organizationProfileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accountId: 'new-acc-1', organizationName: 'Acme' }),
      }),
    );
    expect(orgMemberCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG_1,
          accountId: 'new-acc-1',
          role: 'LEAD_AUDITOR',
          status: 'ACTIVE',
        }),
      }),
    );
    expect(invitationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv-1' },
        data: expect.objectContaining({ status: 'ACCEPTED' }),
      }),
    );
    expect(result.accessToken).toEqual(expect.any(String));
  });

  it('attaches an existing account when the invited email already has one', async () => {
    const futureExpiry = new Date(Date.now() + 1000 * 60 * 60);
    orgInvitationDb.findUnique.mockResolvedValue({
      id: 'inv-2',
      organizationId: ORG_1,
      email: 'already@test.com',
      role: 'VIEWER',
      status: 'PENDING',
      expiresAt: futureExpiry,
      token: 'tok-2',
    });
    accountDb.findFirst.mockResolvedValue({
      id: 'existing-acc-1',
      email: 'already@test.com',
      password: bcrypt.hashSync('correct-password', 10),
      role: 'ORGANIZATION',
      provider: 'LOCAL',
      isDeleted: false,
      isAccountVerified: true,
      orgMembership: null,
    });

    const orgMemberCreate = vi.fn().mockResolvedValue({});
    const invitationUpdate = vi.fn().mockResolvedValue({});
    mockTransaction.mockImplementation(async (fn) =>
      fn({
        orgMember: { create: orgMemberCreate },
        orgInvitation: { update: invitationUpdate },
      }),
    );

    const result = await organization_services.accept_invitation_into_db(
      makeReq({
        body: { token: 'tok-2', password: 'correct-password' },
      }),
    );

    expect(orgMemberCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accountId: 'existing-acc-1', role: 'VIEWER' }),
      }),
    );
    expect(result.isNewAccount).toBe(false);
  });

  it('rejects wrong password for an existing account without creating anything', async () => {
    const futureExpiry = new Date(Date.now() + 1000 * 60 * 60);
    orgInvitationDb.findUnique.mockResolvedValue({
      id: 'inv-3',
      organizationId: ORG_1,
      email: 'already@test.com',
      role: 'VIEWER',
      status: 'PENDING',
      expiresAt: futureExpiry,
      token: 'tok-3',
    });
    accountDb.findFirst.mockResolvedValue({
      id: 'existing-acc-1',
      email: 'already@test.com',
      password: bcrypt.hashSync('correct-password', 10),
      role: 'ORGANIZATION',
      provider: 'LOCAL',
      isDeleted: false,
      isAccountVerified: true,
      orgMembership: null,
    });

    await expect(
      organization_services.accept_invitation_into_db(
        makeReq({ body: { token: 'tok-3', password: 'wrong-password' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects an existing OAuth account instead of crashing on a null password hash', async () => {
    const futureExpiry = new Date(Date.now() + 1000 * 60 * 60);
    orgInvitationDb.findUnique.mockResolvedValue({
      id: 'inv-oauth',
      organizationId: ORG_1,
      email: 'oauth@test.com',
      role: 'VIEWER',
      status: 'PENDING',
      expiresAt: futureExpiry,
      token: 'tok-oauth',
    });
    accountDb.findFirst.mockResolvedValue({
      id: 'existing-acc-oauth',
      email: 'oauth@test.com',
      password: null,
      role: 'ORGANIZATION',
      provider: 'GOOGLE',
      isDeleted: false,
      isAccountVerified: true,
      orgMembership: null,
    });

    await expect(
      organization_services.accept_invitation_into_db(
        makeReq({ body: { token: 'tok-oauth', password: 'anything' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('finds an existing account by case-insensitive email match', async () => {
    const futureExpiry = new Date(Date.now() + 1000 * 60 * 60);
    orgInvitationDb.findUnique.mockResolvedValue({
      id: 'inv-case',
      organizationId: ORG_1,
      email: 'Jane@Company.com',
      role: 'VIEWER',
      status: 'PENDING',
      expiresAt: futureExpiry,
      token: 'tok-case',
    });
    accountDb.findFirst.mockResolvedValue({
      id: 'existing-acc-jane',
      email: 'jane@company.com',
      password: bcrypt.hashSync('correct-password', 10),
      role: 'ORGANIZATION',
      provider: 'LOCAL',
      isDeleted: false,
      isAccountVerified: true,
      orgMembership: null,
    });

    const orgMemberCreate = vi.fn().mockResolvedValue({});
    const invitationUpdate = vi.fn().mockResolvedValue({});
    mockTransaction.mockImplementation(async (fn) =>
      fn({
        orgMember: { create: orgMemberCreate },
        orgInvitation: { update: invitationUpdate },
      }),
    );

    const result = await organization_services.accept_invitation_into_db(
      makeReq({ body: { token: 'tok-case', password: 'correct-password' } }),
    );

    expect(accountDb.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'Jane@Company.com', mode: 'insensitive' } },
      }),
    );
    expect(result.isNewAccount).toBe(false);
    expect(orgMemberCreate).toHaveBeenCalled();
  });

  it('rejects accepting into a deleted account', async () => {
    const futureExpiry = new Date(Date.now() + 1000 * 60 * 60);
    orgInvitationDb.findUnique.mockResolvedValue({
      id: 'inv-deleted',
      organizationId: ORG_1,
      email: 'deleted@test.com',
      role: 'VIEWER',
      status: 'PENDING',
      expiresAt: futureExpiry,
      token: 'tok-deleted',
    });
    accountDb.findFirst.mockResolvedValue({
      id: 'existing-acc-deleted',
      email: 'deleted@test.com',
      password: bcrypt.hashSync('correct-password', 10),
      role: 'ORGANIZATION',
      provider: 'LOCAL',
      isDeleted: true,
      isAccountVerified: true,
      orgMembership: null,
    });

    await expect(
      organization_services.accept_invitation_into_db(
        makeReq({ body: { token: 'tok-deleted', password: 'correct-password' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects accepting into an unverified account', async () => {
    const futureExpiry = new Date(Date.now() + 1000 * 60 * 60);
    orgInvitationDb.findUnique.mockResolvedValue({
      id: 'inv-unverified',
      organizationId: ORG_1,
      email: 'unverified@test.com',
      role: 'VIEWER',
      status: 'PENDING',
      expiresAt: futureExpiry,
      token: 'tok-unverified',
    });
    accountDb.findFirst.mockResolvedValue({
      id: 'existing-acc-unverified',
      email: 'unverified@test.com',
      password: bcrypt.hashSync('correct-password', 10),
      role: 'ORGANIZATION',
      provider: 'LOCAL',
      isDeleted: false,
      isAccountVerified: false,
      orgMembership: null,
    });

    await expect(
      organization_services.accept_invitation_into_db(
        makeReq({ body: { token: 'tok-unverified', password: 'correct-password' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 401 });

    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('converts a concurrent-accept unique-constraint race into a clean 409 instead of a raw 500', async () => {
    const futureExpiry = new Date(Date.now() + 1000 * 60 * 60);
    orgInvitationDb.findUnique.mockResolvedValue({
      id: 'inv-race',
      organizationId: ORG_1,
      email: 'race@test.com',
      role: 'VIEWER',
      status: 'PENDING',
      expiresAt: futureExpiry,
      token: 'tok-race',
    });
    accountDb.findFirst.mockResolvedValue({
      id: 'existing-acc-race',
      email: 'race@test.com',
      password: bcrypt.hashSync('correct-password', 10),
      role: 'ORGANIZATION',
      provider: 'LOCAL',
      isDeleted: false,
      isAccountVerified: true,
      orgMembership: null,
    });

    const { Prisma } = await import('@prisma/client');
    mockTransaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      organization_services.accept_invitation_into_db(
        makeReq({ body: { token: 'tok-race', password: 'correct-password' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('marks an expired invitation EXPIRED and rejects', async () => {
    const pastExpiry = new Date(Date.now() - 1000 * 60 * 60);
    orgInvitationDb.findUnique.mockResolvedValue({
      id: 'inv-4',
      organizationId: ORG_1,
      email: 'late@test.com',
      role: 'VIEWER',
      status: 'PENDING',
      expiresAt: pastExpiry,
      token: 'tok-4',
    });
    orgInvitationDb.update.mockResolvedValue({});

    await expect(
      organization_services.accept_invitation_into_db(
        makeReq({ body: { token: 'tok-4', password: 'x', fullName: 'y' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(orgInvitationDb.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'inv-4' }, data: { status: 'EXPIRED' } }),
    );
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects an already-ACCEPTED invitation (no double accept)', async () => {
    orgInvitationDb.findUnique.mockResolvedValue({
      id: 'inv-5',
      organizationId: ORG_1,
      email: 'done@test.com',
      role: 'VIEWER',
      status: 'ACCEPTED',
      expiresAt: new Date(Date.now() + 100000),
      token: 'tok-5',
    });

    await expect(
      organization_services.accept_invitation_into_db(
        makeReq({ body: { token: 'tok-5', password: 'x' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rejects when the target account already belongs to a different org (one-account-one-org)', async () => {
    const futureExpiry = new Date(Date.now() + 1000 * 60 * 60);
    orgInvitationDb.findUnique.mockResolvedValue({
      id: 'inv-6',
      organizationId: ORG_1,
      email: 'already@test.com',
      role: 'VIEWER',
      status: 'PENDING',
      expiresAt: futureExpiry,
      token: 'tok-6',
    });
    accountDb.findFirst.mockResolvedValue({
      id: 'existing-acc-2',
      email: 'already@test.com',
      password: bcrypt.hashSync('correct-password', 10),
      role: 'ORGANIZATION',
      orgMembership: { organizationId: ORG_2 },
    });

    await expect(
      organization_services.accept_invitation_into_db(
        makeReq({ body: { token: 'tok-6', password: 'correct-password' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe('organization service — list org members', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ADMIN lists members scoped to their own org', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    const members = [
      {
        id: 'member-1',
        role: 'LEAD_AUDITOR',
        status: 'ACTIVE',
        expiresAt: null,
        createdAt: new Date(),
        account: { email: 'auditor@test.com', profile: { fullName: 'Auditor One' } },
      },
    ];
    orgMemberDb.findMany.mockResolvedValue(members);

    const result = await organization_services.get_org_members_from_db(
      makeReq({ user: { accountId: 'admin-1' } }),
    );

    expect(orgMemberDb.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_1 } }),
    );
    // isExpired is a derived field the service adds on top of the raw row —
    // see the doc comment on get_org_members_from_db for why it's derived
    // rather than written back to `status`.
    expect(result).toEqual(members.map((m) => ({ ...m, isExpired: false })));
  });

  it('rejects a caller with no org membership at all', async () => {
    orgMemberDb.findUnique.mockResolvedValue(null);

    await expect(
      organization_services.get_org_members_from_db(makeReq({ user: { accountId: 'nobody' } })),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(orgMemberDb.findMany).not.toHaveBeenCalled();
  });

  it('rejects a non-admin member', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'lead-1',
      role: 'LEAD_AUDITOR',
      status: 'ACTIVE',
      expiresAt: null,
    });

    await expect(
      organization_services.get_org_members_from_db(makeReq({ user: { accountId: 'lead-1' } })),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(orgMemberDb.findMany).not.toHaveBeenCalled();
  });

  it('rejects a SUSPENDED admin', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'SUSPENDED',
      expiresAt: null,
    });

    await expect(
      organization_services.get_org_members_from_db(makeReq({ user: { accountId: 'admin-1' } })),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(orgMemberDb.findMany).not.toHaveBeenCalled();
  });
});

describe('organization service — list pending invitations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ADMIN lists pending invitations scoped to their own org', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    const invitations = [
      {
        id: 'inv-1',
        email: 'x@test.com',
        role: 'VIEWER',
        status: 'PENDING',
        expiresAt: new Date(),
      },
    ];
    orgInvitationDb.findMany.mockResolvedValue(invitations);

    const result = await organization_services.get_pending_invitations_from_db(
      makeReq({ user: { accountId: 'admin-1' } }),
    );

    expect(orgInvitationDb.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_1, status: 'PENDING' } }),
    );
    expect(result).toEqual(invitations);
  });

  it('rejects a non-admin member', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'lead-1',
      role: 'LEAD_AUDITOR',
      status: 'ACTIVE',
      expiresAt: null,
    });

    await expect(
      organization_services.get_pending_invitations_from_db(
        makeReq({ user: { accountId: 'lead-1' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(orgInvitationDb.findMany).not.toHaveBeenCalled();
  });

  it('rejects a SUSPENDED admin', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'SUSPENDED',
      expiresAt: null,
    });

    await expect(
      organization_services.get_pending_invitations_from_db(
        makeReq({ user: { accountId: 'admin-1' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(orgInvitationDb.findMany).not.toHaveBeenCalled();
  });
});

describe('organization service — update org member', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The last-admin count-and-update is now wrapped in a Serializable
    // prisma.$transaction — hand the callback a tx backed by the same
    // orgMemberDb mock so existing assertions on orgMemberDb.count/update
    // still see the calls made inside it.
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ orgMember: orgMemberDb }),
    );
  });

  it('ADMIN updates a member status scoped to their own org', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.findFirst.mockResolvedValue({
      id: 'member-1',
      organizationId: ORG_1,
      accountId: 'other-account',
      role: 'LEAD_AUDITOR',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.update.mockResolvedValue({
      id: 'member-1',
      role: 'LEAD_AUDITOR',
      status: 'SUSPENDED',
      expiresAt: null,
      account: { email: 'auditor@test.com', profile: { fullName: 'Auditor One' } },
    });

    const result = await organization_services.update_org_member_in_db(
      makeReq({
        user: { accountId: 'admin-1' },
        params: { id: 'member-1' },
        body: { status: 'SUSPENDED' },
      }),
    );

    expect(orgMemberDb.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'member-1', organizationId: ORG_1 } }),
    );
    expect(orgMemberDb.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'member-1' },
        data: { status: 'SUSPENDED' },
      }),
    );
    expect(result.status).toBe('SUSPENDED');
  });

  it('sets expiresAt (time-boxed access) without touching status when only expiresAt is provided', async () => {
    const futureExpiry = new Date(Date.now() + 1000 * 60 * 60);
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.findFirst.mockResolvedValue({
      id: 'member-2',
      organizationId: ORG_1,
      accountId: 'other-account',
      role: 'VIEWER',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.update.mockResolvedValue({
      id: 'member-2',
      role: 'VIEWER',
      status: 'ACTIVE',
      expiresAt: futureExpiry,
      account: { email: 'viewer@test.com', profile: { fullName: 'Viewer One' } },
    });

    await organization_services.update_org_member_in_db(
      makeReq({
        user: { accountId: 'admin-1' },
        params: { id: 'member-2' },
        body: { expiresAt: futureExpiry },
      }),
    );

    expect(orgMemberDb.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'member-2' },
        data: { expiresAt: futureExpiry },
      }),
    );
  });

  it('clears an existing expiry when expiresAt is explicitly null', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.findFirst.mockResolvedValue({
      id: 'member-3',
      organizationId: ORG_1,
      accountId: 'other-account',
      role: 'VIEWER',
      status: 'ACTIVE',
      expiresAt: new Date(),
    });
    orgMemberDb.update.mockResolvedValue({
      id: 'member-3',
      role: 'VIEWER',
      status: 'ACTIVE',
      expiresAt: null,
      account: { email: 'viewer@test.com', profile: { fullName: 'Viewer One' } },
    });

    await organization_services.update_org_member_in_db(
      makeReq({
        user: { accountId: 'admin-1' },
        params: { id: 'member-3' },
        body: { expiresAt: null },
      }),
    );

    expect(orgMemberDb.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'member-3' },
        data: { expiresAt: null },
      }),
    );
  });

  it('rejects (404, org-scoped) a member id belonging to a different org', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.findFirst.mockResolvedValue(null);

    await expect(
      organization_services.update_org_member_in_db(
        makeReq({
          user: { accountId: 'admin-1' },
          params: { id: 'member-other-org' },
          body: { status: 'SUSPENDED' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(orgMemberDb.update).not.toHaveBeenCalled();
  });

  it('rejects a non-admin caller', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'lead-1',
      role: 'LEAD_AUDITOR',
      status: 'ACTIVE',
      expiresAt: null,
    });

    await expect(
      organization_services.update_org_member_in_db(
        makeReq({
          user: { accountId: 'lead-1' },
          params: { id: 'member-1' },
          body: { status: 'SUSPENDED' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(orgMemberDb.findFirst).not.toHaveBeenCalled();
  });

  it('rejects an admin trying to suspend/expire their own membership (self-lockout guard)', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.findFirst.mockResolvedValue({
      id: 'member-self',
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });

    await expect(
      organization_services.update_org_member_in_db(
        makeReq({
          user: { accountId: 'admin-1' },
          params: { id: 'member-self' },
          body: { status: 'SUSPENDED' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(orgMemberDb.update).not.toHaveBeenCalled();
  });

  it('rejects deactivating the last other active admin — would leave the org with zero active admins', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.findFirst.mockResolvedValue({
      id: 'member-other-admin',
      organizationId: ORG_1,
      accountId: 'admin-2',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.count.mockResolvedValue(0); // no OTHER active admin besides this target

    await expect(
      organization_services.update_org_member_in_db(
        makeReq({
          user: { accountId: 'admin-1' },
          params: { id: 'member-other-admin' },
          body: { status: 'SUSPENDED' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(orgMemberDb.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG_1,
          role: 'ADMIN',
          status: 'ACTIVE',
          id: { not: 'member-other-admin' },
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        },
      }),
    );
    expect(orgMemberDb.update).not.toHaveBeenCalled();
  });

  it('allows deactivating an admin when another active admin remains', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.findFirst.mockResolvedValue({
      id: 'member-other-admin',
      organizationId: ORG_1,
      accountId: 'admin-2',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.count.mockResolvedValue(1); // a third admin exists
    orgMemberDb.update.mockResolvedValue({
      id: 'member-other-admin',
      role: 'ADMIN',
      status: 'SUSPENDED',
      expiresAt: null,
      account: { email: 'admin2@test.com', profile: { fullName: 'Admin Two' } },
    });

    const result = await organization_services.update_org_member_in_db(
      makeReq({
        user: { accountId: 'admin-1' },
        params: { id: 'member-other-admin' },
        body: { status: 'SUSPENDED' },
      }),
    );

    expect(orgMemberDb.update).toHaveBeenCalled();
    expect(result.status).toBe('SUSPENDED');
  });

  it('does not count an admin whose own expiresAt has already lapsed as a valid "other admin"', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.findFirst.mockResolvedValue({
      id: 'member-other-admin',
      organizationId: ORG_1,
      accountId: 'admin-2',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });

    // Simulate a real DB instead of a bare mocked count: a third admin row
    // whose own time-boxed expiresAt lapsed an hour ago. count()'s
    // implementation here actually applies the where-clause's OR semantics
    // against this row, so the test fails if the code stops filtering out
    // lapsed-but-still-status-ACTIVE admins.
    const expiredThirdAdmin = {
      id: 'member-expired-admin',
      organizationId: ORG_1,
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 1000 * 60 * 60),
    };
    orgMemberDb.count.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        new Promise((resolve) => {
          const row = expiredThirdAdmin;
          const notExcluded = (where.id as { not: string })?.not !== row.id;
          const orgMatches = where.organizationId === row.organizationId;
          const roleMatches = where.role === row.role;
          const statusMatches = where.status === row.status;
          const orClauses = where.OR as Array<Record<string, unknown>> | undefined;
          const passesOr = !!orClauses?.some((clause) => {
            if (clause.expiresAt === null) return row.expiresAt === null;
            const gt = (clause.expiresAt as { gt?: Date } | undefined)?.gt;
            return !!gt && row.expiresAt.getTime() > gt.getTime();
          });
          resolve(orgMatches && roleMatches && statusMatches && notExcluded && passesOr ? 1 : 0);
        }),
    );

    await expect(
      organization_services.update_org_member_in_db(
        makeReq({
          user: { accountId: 'admin-1' },
          params: { id: 'member-other-admin' },
          body: { status: 'SUSPENDED' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(orgMemberDb.update).not.toHaveBeenCalled();
  });

  it('does not run the last-admin check when deactivating a non-admin', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.findFirst.mockResolvedValue({
      id: 'member-lead',
      organizationId: ORG_1,
      accountId: 'lead-1',
      role: 'LEAD_AUDITOR',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgMemberDb.update.mockResolvedValue({
      id: 'member-lead',
      role: 'LEAD_AUDITOR',
      status: 'SUSPENDED',
      expiresAt: null,
      account: { email: 'lead@test.com', profile: { fullName: 'Lead One' } },
    });

    await organization_services.update_org_member_in_db(
      makeReq({
        user: { accountId: 'admin-1' },
        params: { id: 'member-lead' },
        body: { status: 'SUSPENDED' },
      }),
    );

    expect(orgMemberDb.count).not.toHaveBeenCalled();
    expect(orgMemberDb.update).toHaveBeenCalled();
  });

  it('rejects a SUSPENDED admin trying to update another member — the endpoint whose entire job is revoking access must actually revoke it', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'SUSPENDED',
      expiresAt: null,
    });

    await expect(
      organization_services.update_org_member_in_db(
        makeReq({
          user: { accountId: 'admin-1' },
          params: { id: 'some-other-member' },
          body: { status: 'ACTIVE' },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(orgMemberDb.findFirst).not.toHaveBeenCalled();
    expect(orgMemberDb.update).not.toHaveBeenCalled();
  });
});

describe('organization service — resend invitation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refreshes expiresAt and resends for a still-PENDING invitation belonging to the caller org', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgInvitationDb.findFirst.mockResolvedValue({
      id: 'inv-7',
      organizationId: ORG_1,
      email: 'pending@test.com',
      status: 'PENDING',
      token: 'tok-7',
    });
    organizationDb.findUniqueOrThrow.mockResolvedValue({ name: 'Acme' });
    orgInvitationDb.update.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'inv-7',
        email: 'pending@test.com',
        role: 'VIEWER',
        status: 'PENDING',
        token: 'tok-7',
        ...data,
      }),
    );

    await organization_services.resend_invitation_from_db(
      makeReq({ user: { accountId: 'admin-1' }, params: { id: 'inv-7' } }),
    );

    expect(orgInvitationDb.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'inv-7' },
        data: expect.objectContaining({ expiresAt: expect.any(Date) }),
      }),
    );
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it('rotates the token, not just the expiry — invalidates a previously-leaked link', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgInvitationDb.findFirst.mockResolvedValue({
      id: 'inv-7',
      organizationId: ORG_1,
      email: 'pending@test.com',
      status: 'PENDING',
      token: 'old-token-7',
    });
    organizationDb.findUniqueOrThrow.mockResolvedValue({ name: 'Acme' });
    orgInvitationDb.update.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'inv-7',
        email: 'pending@test.com',
        role: 'VIEWER',
        status: 'PENDING',
        ...data,
      }),
    );

    await organization_services.resend_invitation_from_db(
      makeReq({ user: { accountId: 'admin-1' }, params: { id: 'inv-7' } }),
    );

    const [updateArg] = orgInvitationDb.update.mock.calls[0];
    expect(updateArg.data.token).toEqual(expect.any(String));
    expect(updateArg.data.token).not.toBe('old-token-7');
    expect(updateArg.data.token.length).toBeGreaterThanOrEqual(32);

    const [, emailPayload] = mockQueueAdd.mock.calls[0];
    // The link sent out must carry the new token, not the stale one.
    expect(emailPayload.inviteLink).not.toContain('old-token-7');
  });

  it('rejects resending an invitation that is not PENDING', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgInvitationDb.findFirst.mockResolvedValue({
      id: 'inv-8',
      organizationId: ORG_1,
      email: 'accepted@test.com',
      status: 'ACCEPTED',
      token: 'tok-8',
    });

    await expect(
      organization_services.resend_invitation_from_db(
        makeReq({ user: { accountId: 'admin-1' }, params: { id: 'inv-8' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(orgInvitationDb.update).not.toHaveBeenCalled();
  });

  it('rejects resending an invitation that belongs to a different org', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
    orgInvitationDb.findFirst.mockResolvedValue(null);

    await expect(
      organization_services.resend_invitation_from_db(
        makeReq({ user: { accountId: 'admin-1' }, params: { id: 'inv-other-org' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects a SUSPENDED admin', async () => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId: 'admin-1',
      role: 'ADMIN',
      status: 'SUSPENDED',
      expiresAt: null,
    });

    await expect(
      organization_services.resend_invitation_from_db(
        makeReq({ user: { accountId: 'admin-1' }, params: { id: 'inv-7' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(orgInvitationDb.findFirst).not.toHaveBeenCalled();
  });
});

describe('organization service — settings (issue #55 slice 4)', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('get_organization_settings_from_db', () => {
    it('ADMIN can read the org settings', async () => {
      orgMemberDb.findUnique.mockResolvedValue({
        organizationId: ORG_1,
        accountId: 'admin-1',
        role: 'ADMIN',
        status: 'ACTIVE',
        expiresAt: null,
      });
      organizationDb.findUniqueOrThrow.mockResolvedValue({
        id: ORG_1,
        name: 'Acme',
        requireApprovalForSubAssignment: true,
      });

      const result = await organization_services.get_organization_settings_from_db(
        makeReq({ user: { accountId: 'admin-1' } }),
      );

      expect(result.requireApprovalForSubAssignment).toBe(true);
    });

    it('ADMIN can read leadAuditorRoleLabel', async () => {
      orgMemberDb.findUnique.mockResolvedValue({
        organizationId: ORG_1,
        accountId: 'admin-1',
        role: 'ADMIN',
        status: 'ACTIVE',
        expiresAt: null,
      });
      organizationDb.findUniqueOrThrow.mockResolvedValue({
        id: ORG_1,
        name: 'Acme',
        requireApprovalForSubAssignment: false,
        leadAuditorRoleLabel: 'Senior Inspector',
      });

      const result = await organization_services.get_organization_settings_from_db(
        makeReq({ user: { accountId: 'admin-1' } }),
      );

      expect(result.leadAuditorRoleLabel).toBe('Senior Inspector');
    });

    it('non-ADMIN cannot read the org settings', async () => {
      orgMemberDb.findUnique.mockResolvedValue({
        organizationId: ORG_1,
        accountId: 'lead-1',
        role: 'LEAD_AUDITOR',
        status: 'ACTIVE',
        expiresAt: null,
      });

      await expect(
        organization_services.get_organization_settings_from_db(
          makeReq({ user: { accountId: 'lead-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(organizationDb.findUniqueOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('update_organization_settings_in_db', () => {
    it('ADMIN can toggle requireApprovalForSubAssignment on', async () => {
      orgMemberDb.findUnique.mockResolvedValue({
        organizationId: ORG_1,
        accountId: 'admin-1',
        role: 'ADMIN',
        status: 'ACTIVE',
        expiresAt: null,
      });
      organizationDb.findUniqueOrThrow.mockResolvedValue({
        requireApprovalForSubAssignment: false,
      });
      organizationDb.update.mockResolvedValue({
        id: ORG_1,
        name: 'Acme',
        requireApprovalForSubAssignment: true,
      });

      const result = await organization_services.update_organization_settings_in_db(
        makeReq({
          user: { accountId: 'admin-1' },
          body: { requireApprovalForSubAssignment: true },
        }),
      );

      expect(organizationDb.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ORG_1 },
          data: { requireApprovalForSubAssignment: true },
        }),
      );
      expect(result.requireApprovalForSubAssignment).toBe(true);
    });

    it('ADMIN can update leadAuditorRoleLabel independently of requireApprovalForSubAssignment', async () => {
      orgMemberDb.findUnique.mockResolvedValue({
        organizationId: ORG_1,
        accountId: 'admin-1',
        role: 'ADMIN',
        status: 'ACTIVE',
        expiresAt: null,
      });
      organizationDb.findUniqueOrThrow.mockResolvedValue({
        requireApprovalForSubAssignment: false,
        leadAuditorRoleLabel: 'Lead Auditor',
      });
      organizationDb.update.mockResolvedValue({
        id: ORG_1,
        name: 'Acme',
        requireApprovalForSubAssignment: false,
        leadAuditorRoleLabel: 'Senior Inspector',
      });

      const result = await organization_services.update_organization_settings_in_db(
        makeReq({
          user: { accountId: 'admin-1' },
          body: { leadAuditorRoleLabel: 'Senior Inspector' },
        }),
      );

      expect(organizationDb.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ORG_1 },
          data: { leadAuditorRoleLabel: 'Senior Inspector' },
        }),
      );
      expect(result.leadAuditorRoleLabel).toBe('Senior Inspector');
    });

    it('non-ADMIN cannot update the org settings', async () => {
      orgMemberDb.findUnique.mockResolvedValue({
        organizationId: ORG_1,
        accountId: 'lead-1',
        role: 'LEAD_AUDITOR',
        status: 'ACTIVE',
        expiresAt: null,
      });

      await expect(
        organization_services.update_organization_settings_in_db(
          makeReq({
            user: { accountId: 'lead-1' },
            body: { requireApprovalForSubAssignment: true },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(organizationDb.update).not.toHaveBeenCalled();
    });
  });
});

describe('organization service — external member management (issue #55 slice 5)', () => {
  beforeEach(() => vi.clearAllMocks());

  const mockAdmin = (accountId = 'admin-1') => {
    orgMemberDb.findUnique.mockResolvedValue({
      organizationId: ORG_1,
      accountId,
      role: 'ADMIN',
      status: 'ACTIVE',
      expiresAt: null,
    });
  };

  describe('invite_external_member_into_db', () => {
    it('creates a new external LIGHT_USER member', async () => {
      mockAdmin();
      externalOrgMemberDb.findUnique.mockResolvedValue(null);
      externalOrgMemberDb.create.mockResolvedValue({ id: 'ext-1', role: 'LIGHT_USER' });

      await organization_services.invite_external_member_into_db(
        makeReq({
          user: { accountId: 'admin-1' },
          body: { email: 'Contractor@Test.com', fullName: 'Contractor' },
        }),
      );

      expect(externalOrgMemberDb.create).toHaveBeenCalledWith({
        data: {
          organizationId: ORG_1,
          email: 'contractor@test.com',
          fullName: 'Contractor',
          role: 'LIGHT_USER',
        },
      });
    });

    it('rejects an explicit role of VIEWER — not supported yet', async () => {
      mockAdmin();

      await expect(
        organization_services.invite_external_member_into_db(
          makeReq({
            user: { accountId: 'admin-1' },
            body: { email: 'x@test.com', role: 'VIEWER' },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(externalOrgMemberDb.create).not.toHaveBeenCalled();
    });

    it('rejects when the email is already an active external member', async () => {
      mockAdmin();
      externalOrgMemberDb.findUnique.mockResolvedValue({
        id: 'ext-1',
        organizationId: ORG_1,
        email: 'x@test.com',
        isActive: true,
      });

      await expect(
        organization_services.invite_external_member_into_db(
          makeReq({ user: { accountId: 'admin-1' }, body: { email: 'x@test.com' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(externalOrgMemberDb.create).not.toHaveBeenCalled();
    });

    it('reactivates a previously-removed external member instead of creating a duplicate', async () => {
      mockAdmin();
      externalOrgMemberDb.findUnique.mockResolvedValue({
        id: 'ext-1',
        organizationId: ORG_1,
        email: 'x@test.com',
        isActive: false,
      });
      externalOrgMemberDb.update.mockResolvedValue({ id: 'ext-1', isActive: true });

      await organization_services.invite_external_member_into_db(
        makeReq({ user: { accountId: 'admin-1' }, body: { email: 'x@test.com' } }),
      );

      expect(externalOrgMemberDb.create).not.toHaveBeenCalled();
      expect(externalOrgMemberDb.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ext-1' },
          data: expect.objectContaining({ isActive: true, expiresAt: null }),
        }),
      );
    });

    it('rejects a non-admin caller', async () => {
      orgMemberDb.findUnique.mockResolvedValue({
        organizationId: ORG_1,
        accountId: 'lead-1',
        role: 'LEAD_AUDITOR',
        status: 'ACTIVE',
        expiresAt: null,
      });

      await expect(
        organization_services.invite_external_member_into_db(
          makeReq({ user: { accountId: 'lead-1' }, body: { email: 'x@test.com' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(externalOrgMemberDb.create).not.toHaveBeenCalled();
    });
  });

  describe('get_external_members_from_db', () => {
    it('lists external members scoped to the caller org, with a derived isExpired field', async () => {
      mockAdmin();
      externalOrgMemberDb.findMany.mockResolvedValue([
        { id: 'ext-1', email: 'a@test.com', isActive: true, expiresAt: null },
        {
          id: 'ext-2',
          email: 'b@test.com',
          isActive: true,
          expiresAt: new Date(Date.now() - 1000),
        },
      ]);

      const result = await organization_services.get_external_members_from_db(
        makeReq({ user: { accountId: 'admin-1' } }),
      );

      expect(externalOrgMemberDb.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: ORG_1 } }),
      );
      expect(result[0].isExpired).toBe(false);
      expect(result[1].isExpired).toBe(true);
    });
  });

  describe('update_external_member_in_db', () => {
    it('deactivates an external member and records an EXTERNAL_MEMBER_REMOVED audit event', async () => {
      mockAdmin();
      externalOrgMemberDb.findFirst.mockResolvedValue({
        id: 'ext-1',
        organizationId: ORG_1,
        email: 'x@test.com',
        isActive: true,
        expiresAt: null,
      });
      externalOrgMemberDb.update.mockResolvedValue({
        id: 'ext-1',
        isActive: false,
        expiresAt: null,
      });

      await organization_services.update_external_member_in_db(
        makeReq({
          user: { accountId: 'admin-1' },
          params: { id: 'ext-1' },
          body: { isActive: false },
        }),
      );

      expect(externalOrgMemberDb.update).toHaveBeenCalledWith({
        where: { id: 'ext-1' },
        data: { isActive: false },
      });
      expect(prisma.orgAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'EXTERNAL_MEMBER_REMOVED' }),
        }),
      );
    });

    it('records EXTERNAL_MEMBER_REMOVED when access is cut off via a past expiresAt, not just isActive:false (issue #55 slice 5 follow-up)', async () => {
      mockAdmin();
      externalOrgMemberDb.findFirst.mockResolvedValue({
        id: 'ext-1',
        organizationId: ORG_1,
        email: 'x@test.com',
        isActive: true,
        expiresAt: null,
      });
      const pastDate = new Date(Date.now() - 1000);
      externalOrgMemberDb.update.mockResolvedValue({
        id: 'ext-1',
        isActive: true,
        expiresAt: pastDate,
      });

      await organization_services.update_external_member_in_db(
        makeReq({
          user: { accountId: 'admin-1' },
          params: { id: 'ext-1' },
          body: { expiresAt: pastDate },
        }),
      );

      expect(prisma.orgAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'EXTERNAL_MEMBER_REMOVED' }),
        }),
      );
    });

    it('does NOT record an audit event when the member remains active after the update', async () => {
      mockAdmin();
      externalOrgMemberDb.findFirst.mockResolvedValue({
        id: 'ext-1',
        organizationId: ORG_1,
        email: 'x@test.com',
        isActive: true,
        expiresAt: null,
      });
      const futureDate = new Date(Date.now() + 100000);
      externalOrgMemberDb.update.mockResolvedValue({
        id: 'ext-1',
        isActive: true,
        expiresAt: futureDate,
      });

      await organization_services.update_external_member_in_db(
        makeReq({
          user: { accountId: 'admin-1' },
          params: { id: 'ext-1' },
          body: { expiresAt: futureDate },
        }),
      );

      expect(prisma.orgAuditLog.create).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT update another org external member', async () => {
      mockAdmin();
      externalOrgMemberDb.findFirst.mockResolvedValue(null);

      await expect(
        organization_services.update_external_member_in_db(
          makeReq({
            user: { accountId: 'admin-1' },
            params: { id: 'org-b-ext' },
            body: { isActive: false },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(externalOrgMemberDb.update).not.toHaveBeenCalled();
    });
  });
});
