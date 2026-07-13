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
    },
    account: {
      findUnique: vi.fn(),
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
    accountDb.findUnique.mockResolvedValue(null);

    const orgMemberCreate = vi.fn().mockResolvedValue({});
    const invitationUpdate = vi.fn().mockResolvedValue({});
    const accountCreate = vi.fn().mockResolvedValue({ id: 'new-acc-1' });
    const profileCreate = vi.fn().mockResolvedValue({});
    mockTransaction.mockImplementation(async (fn) =>
      fn({
        account: { create: accountCreate },
        profile: { create: profileCreate },
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
    accountDb.findUnique.mockResolvedValue({
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
    accountDb.findUnique.mockResolvedValue({
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
    accountDb.findUnique.mockResolvedValue({
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
    accountDb.findUnique.mockResolvedValue({
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
    accountDb.findUnique.mockResolvedValue({
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
    accountDb.findUnique.mockResolvedValue({
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
    accountDb.findUnique.mockResolvedValue({
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
    expect(result).toEqual(members);
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
});

describe('organization service — update org member', () => {
  beforeEach(() => vi.clearAllMocks());

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
});
