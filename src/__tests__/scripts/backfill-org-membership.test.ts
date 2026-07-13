import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    account: {
      findMany: vi.fn(),
    },
    organization: {
      create: vi.fn(),
    },
    orgMember: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { backfillOrgMembership } from '../../scripts/backfill-org-membership.js';

const accountDb = prisma.account as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mockTransaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;

describe('backfill-org-membership script (issue #55 slice 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mirrors the tx callback pattern used in account.service.ts — hands the
    // callback a tx object backed by the same organization/orgMember mocks
    // so assertions can check what was created.
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        organization: organizationDb,
        orgMember: orgMemberDb,
      }),
    );
  });

  it('creates a new Organization + OrgMember(ADMIN) for an account with no existing OrgMember', async () => {
    accountDb.findMany.mockResolvedValue([
      {
        id: 'acc-1',
        email: 'owner@acme.com',
        organizationProfile: { organizationName: 'Acme Inc' },
        orgMembership: null,
      },
    ]);
    organizationDb.create.mockResolvedValue({ id: 'org-1' });
    orgMemberDb.create.mockResolvedValue({ id: 'member-1' });

    await backfillOrgMembership();

    expect(organizationDb.create).toHaveBeenCalledWith({
      data: {
        name: 'Acme Inc',
        anchorAccountId: 'acc-1',
      },
    });
    expect(orgMemberDb.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-1',
        accountId: 'acc-1',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });
  });

  it('skips an account that already has an OrgMember row (idempotency, single pass)', async () => {
    accountDb.findMany.mockResolvedValue([
      {
        id: 'acc-2',
        email: 'already@acme.com',
        organizationProfile: null,
        orgMembership: { id: 'existing-member' },
      },
    ]);

    await backfillOrgMembership();

    expect(organizationDb.create).not.toHaveBeenCalled();
    expect(orgMemberDb.create).not.toHaveBeenCalled();
  });

  it('is idempotent across two runs — the second run creates nothing new', async () => {
    const account = {
      id: 'acc-3',
      email: 'twice@acme.com',
      organizationProfile: null,
      orgMembership: null as null | { id: string },
    };
    organizationDb.create.mockResolvedValue({ id: 'org-3' });
    orgMemberDb.create.mockResolvedValue({ id: 'member-3' });

    // First run: no OrgMember yet.
    accountDb.findMany.mockResolvedValueOnce([account]);
    await backfillOrgMembership();
    expect(organizationDb.create).toHaveBeenCalledTimes(1);
    expect(orgMemberDb.create).toHaveBeenCalledTimes(1);

    // Second run: the account now has an OrgMember (as it would after the
    // first run persisted its insert), so nothing new should be created.
    accountDb.findMany.mockResolvedValueOnce([{ ...account, orgMembership: { id: 'member-3' } }]);
    await backfillOrgMembership();
    expect(organizationDb.create).toHaveBeenCalledTimes(1);
    expect(orgMemberDb.create).toHaveBeenCalledTimes(1);
  });

  it('falls back to the account email for the org name when OrganizationProfile has no name', async () => {
    accountDb.findMany.mockResolvedValue([
      {
        id: 'acc-4',
        email: 'noname@acme.com',
        organizationProfile: { organizationName: '' },
        orgMembership: null,
      },
    ]);
    organizationDb.create.mockResolvedValue({ id: 'org-4' });
    orgMemberDb.create.mockResolvedValue({ id: 'member-4' });

    await backfillOrgMembership();

    expect(organizationDb.create).toHaveBeenCalledWith({
      data: {
        name: 'noname@acme.com',
        anchorAccountId: 'acc-4',
      },
    });
  });

  it('falls back to the account email when there is no OrganizationProfile at all', async () => {
    accountDb.findMany.mockResolvedValue([
      {
        id: 'acc-5',
        email: 'noprofile@acme.com',
        organizationProfile: null,
        orgMembership: null,
      },
    ]);
    organizationDb.create.mockResolvedValue({ id: 'org-5' });
    orgMemberDb.create.mockResolvedValue({ id: 'member-5' });

    await backfillOrgMembership();

    expect(organizationDb.create).toHaveBeenCalledWith({
      data: {
        name: 'noprofile@acme.com',
        anchorAccountId: 'acc-5',
      },
    });
  });

  it('excludes soft-deleted accounts from the query, so they never get an Organization row', async () => {
    accountDb.findMany.mockResolvedValue([]);

    await backfillOrgMembership();

    expect(accountDb.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isDeleted: false } }),
    );
  });

  it('wraps each account in its own prisma.$transaction call for per-account atomicity', async () => {
    // NOTE: with the mocked prisma client used across this repo's test suite
    // (see src/__tests__/security/account.service.test.ts), $transaction is
    // just a vi.fn() stub — it doesn't provide real rollback semantics, so
    // we can't assert "if orgMember.create throws, organization.create is
    // rolled back" against a real database here. What we *can* assert is
    // the atomicity contract at the call-site: each account's Organization +
    // OrgMember pair is issued through a single $transaction callback,
    // exactly once per account, rather than as two independent top-level
    // prisma calls.
    accountDb.findMany.mockResolvedValue([
      { id: 'acc-6', email: 'a@acme.com', organizationProfile: null, orgMembership: null },
      { id: 'acc-7', email: 'b@acme.com', organizationProfile: null, orgMembership: null },
    ]);
    organizationDb.create.mockResolvedValue({ id: 'org-x' });
    orgMemberDb.create.mockResolvedValue({ id: 'member-x' });

    await backfillOrgMembership();

    expect(mockTransaction).toHaveBeenCalledTimes(2);
  });

  it('logs a summary count of accounts processed vs skipped', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    accountDb.findMany.mockResolvedValue([
      { id: 'acc-8', email: 'new@acme.com', organizationProfile: null, orgMembership: null },
      {
        id: 'acc-9',
        email: 'old@acme.com',
        organizationProfile: null,
        orgMembership: { id: 'existing' },
      },
    ]);
    organizationDb.create.mockResolvedValue({ id: 'org-8' });
    orgMemberDb.create.mockResolvedValue({ id: 'member-8' });

    await backfillOrgMembership();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('processed: 1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('skipped (already migrated): 1'));

    logSpy.mockRestore();
  });
});
