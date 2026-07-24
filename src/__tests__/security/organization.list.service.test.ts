import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    account: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { organization_services } from '../../app/modules/organization/organization.service.js';

const accountDb = prisma.account as unknown as Record<string, ReturnType<typeof vi.fn>>;

const makeAccountRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'acc-1',
  email: 'admin@acme.test',
  isAccountVerified: true,
  createdAt: new Date('2026-06-01T10:00:00.000Z'),
  organizationProfile: {
    organizationName: 'Acme Corp',
    sector: 'Manufacturing',
    country: 'France',
    organizationLogo: null,
  },
  ...overrides,
});

// The route gates this endpoint with auth('ADMIN') — the SAME platform-admin
// gate POST /organization uses. These service-level tests cover what the
// service itself guarantees once past that gate: it lists real ORGANIZATION
// accounts, only ORGANIZATION accounts, and never soft-deleted ones.
describe('organization service — get_all_organizations_from_db (issue #162)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountDb.count.mockResolvedValue(0);
    accountDb.findMany.mockResolvedValue([]);
  });

  it('lists real ORGANIZATION-role accounts, flattened with their profile', async () => {
    accountDb.findMany.mockResolvedValue([makeAccountRow()]);
    accountDb.count.mockResolvedValue(1);

    const result = await organization_services.get_all_organizations_from_db(makeReq());

    expect(result.data).toEqual([
      {
        id: 'acc-1',
        email: 'admin@acme.test',
        organizationName: 'Acme Corp',
        sector: 'Manufacturing',
        country: 'France',
        organizationLogo: null,
        isAccountVerified: true,
        createdAt: new Date('2026-06-01T10:00:00.000Z'),
      },
    ]);
  });

  it('scopes the query to role ORGANIZATION and excludes soft-deleted accounts', async () => {
    await organization_services.get_all_organizations_from_db(makeReq());

    expect(accountDb.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: 'ORGANIZATION', isDeleted: false }),
      }),
    );
    // The count used for pagination meta must use the SAME filter, or totals
    // would count rows the list can never return.
    expect(accountDb.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: 'ORGANIZATION', isDeleted: false }),
      }),
    );
  });

  it('applies a case-insensitive organizationName search when searchTerm is present', async () => {
    await organization_services.get_all_organizations_from_db(
      makeReq({ query: { searchTerm: 'acme' } }),
    );

    expect(accountDb.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationProfile: {
            organizationName: { contains: 'acme', mode: 'insensitive' },
          },
        }),
      }),
    );
  });

  it('does not add a profile filter when no searchTerm is given', async () => {
    await organization_services.get_all_organizations_from_db(makeReq());

    const whereArg = accountDb.findMany.mock.calls[0][0].where;
    expect(whereArg).not.toHaveProperty('organizationProfile');
  });

  it('returns pagination meta with total and totalPage', async () => {
    accountDb.count.mockResolvedValue(25);
    accountDb.findMany.mockResolvedValue([]);

    const result = await organization_services.get_all_organizations_from_db(
      makeReq({ query: { page: '2', limit: '10' } }),
    );

    expect(result.meta).toMatchObject({ page: 2, limit: 10, total: 25, totalPage: 3 });
    expect(accountDb.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
  });

  it('falls back to the email as a label when a row has no profile', async () => {
    accountDb.findMany.mockResolvedValue([
      makeAccountRow({ organizationProfile: null, email: 'noprofile@acme.test' }),
    ]);
    accountDb.count.mockResolvedValue(1);

    const result = await organization_services.get_all_organizations_from_db(makeReq());

    expect(result.data[0]).toMatchObject({
      organizationName: 'noprofile@acme.test',
      sector: null,
      country: null,
    });
  });
});
