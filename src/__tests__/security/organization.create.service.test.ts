import bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    account: { create: vi.fn(), findFirst: vi.fn() },
    organizationProfile: { create: vi.fn(), findFirst: vi.fn() },
    organization: { create: vi.fn() },
    orgMember: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import {
  assertEmailAvailable,
  assertOrganizationNameAvailable,
  createOrganizationStandalone,
} from '../../app/modules/organization/organization.create.service.js';

const accountDb = prisma.account as unknown as Record<string, ReturnType<typeof vi.fn>>;
const profileDb = prisma.organizationProfile as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;

// A tx client mirroring the real one closely enough for these creates.
const makeTx = () => ({
  account: accountDb,
  organizationProfile: profileDb,
  organization: organizationDb,
  orgMember: orgMemberDb,
});

const VALID = {
  organizationName: 'Acme Corp',
  email: 'admin@acme.test',
  password: 'supersecret',
  sector: 'Manufacturing',
  country: 'France',
};

describe('organization.create.service — createOrganizationStandalone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(makeTx()),
    );
    accountDb.findFirst.mockResolvedValue(null);
    profileDb.findFirst.mockResolvedValue(null);
    accountDb.create.mockResolvedValue({ id: 'acc-1', email: VALID.email, role: 'ORGANIZATION' });
    profileDb.create.mockResolvedValue({ id: 'prof-1' });
    organizationDb.create.mockResolvedValue({ id: 'org-1', name: VALID.organizationName });
    orgMemberDb.create.mockResolvedValue({ id: 'mem-1' });
  });

  it('creates Account(ORGANIZATION) + OrganizationProfile + Organization + OrgMember(ADMIN)', async () => {
    const result = await createOrganizationStandalone(VALID);

    expect(accountDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: VALID.email, role: 'ORGANIZATION' }),
      }),
    );
    // Sector/country land on the profile so the AI proposal is auditable.
    expect(profileDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationName: VALID.organizationName,
          accountId: 'acc-1',
          sector: 'Manufacturing',
          country: 'France',
        }),
      }),
    );
    expect(organizationDb.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: VALID.organizationName, anchorAccountId: 'acc-1' } }),
    );
    expect(orgMemberDb.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accountId: 'acc-1', role: 'ADMIN', status: 'ACTIVE' }),
      }),
    );
    expect(result).toMatchObject({ account: { id: 'acc-1' }, organization: { id: 'org-1' } });
  });

  it('hashes the password (never stores plaintext) and creates the account as already-verified', async () => {
    await createOrganizationStandalone(VALID);
    const created = accountDb.create.mock.calls[0][0].data;
    expect(created.password).not.toBe(VALID.password);
    expect(bcrypt.compareSync(VALID.password, created.password)).toBe(true);
    expect(created.isAccountVerified).toBe(true);
  });

  it('rejects a duplicate email with a 400 BEFORE opening the transaction (no rows created)', async () => {
    accountDb.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(createOrganizationStandalone(VALID)).rejects.toMatchObject({ statusCode: 400 });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(accountDb.create).not.toHaveBeenCalled();
  });

  it('assertEmailAvailable throws 400 when an account already exists', async () => {
    accountDb.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(assertEmailAvailable('taken@acme.test')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects a duplicate organization name with a 400 BEFORE opening the transaction (#212, no rows created)', async () => {
    // Email free, org name taken.
    accountDb.findFirst.mockResolvedValue(null);
    profileDb.findFirst.mockResolvedValue({ id: 'existing-profile' });

    await expect(createOrganizationStandalone(VALID)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/organization with this name already exists/i),
    });

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(accountDb.create).not.toHaveBeenCalled();
  });

  it('assertOrganizationNameAvailable throws 400 and queries case-insensitively on the trimmed name (#212)', async () => {
    profileDb.findFirst.mockResolvedValue({ id: 'existing-profile' });

    await expect(assertOrganizationNameAvailable('  Acme Corp  ')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/organization with this name already exists/i),
    });

    expect(profileDb.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationName: { equals: 'Acme Corp', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('assertOrganizationNameAvailable resolves when no profile uses the name', async () => {
    profileDb.findFirst.mockResolvedValue(null);
    await expect(assertOrganizationNameAvailable('Totally New Org')).resolves.toBeUndefined();
  });
});
