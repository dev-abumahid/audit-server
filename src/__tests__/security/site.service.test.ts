import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    site: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    orgMember: {
      findUnique: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { site_service } from '../../app/modules/site/site.service.js';

const db = prisma.site as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;

const ANCHOR = ORG_A;
const ORG_ID = 'org-00000000-0000-0000-0000-000000000009';
const MEMBER_ID = 'org-member-00000000-0000-0000-0000-000000000009';

const mockMembership = (role: 'ADMIN' | 'LEAD_AUDITOR' | 'LIGHT_USER' | 'VIEWER') => {
  orgMemberDb.findUnique.mockResolvedValue({
    id: MEMBER_ID,
    organizationId: ORG_ID,
    accountId: ORG_A,
    role,
    status: 'ACTIVE',
    expiresAt: null,
  });
  organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ANCHOR });
};

describe('site service — org scoping (ticket #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row — ADMIN-of-self fallback (org anchor ===
    // caller's own accountId), same as every pre-org-scoping-migration test
    // in this file expects.
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  describe('write-path role scoping (issue #55 slice 3)', () => {
    it('VIEWER cannot create a site', async () => {
      mockMembership('VIEWER');

      await expect(
        site_service.create_site_into_db(makeReq({ body: { name: 'HQ' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('LIGHT_USER cannot update a site', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        site_service.update_site_into_db(makeReq({ params: { id: 's1' }, body: { name: 'hack' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.findFirst).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('VIEWER cannot delete a site', async () => {
      mockMembership('VIEWER');

      await expect(
        site_service.delete_site_from_db(makeReq({ params: { id: 's1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.delete).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR (a writer role) can still create a site — role gate does not over-block', async () => {
      mockMembership('LEAD_AUDITOR');
      db.create.mockResolvedValue({});

      await site_service.create_site_into_db(makeReq({ body: { name: 'HQ' } }));

      expect(db.create).toHaveBeenCalled();
    });
  });

  describe('update_site_into_db — org_account_id tamper resistance', () => {
    it('ignores an org_account_id supplied in the body and always writes the caller org anchor', async () => {
      db.findFirst.mockResolvedValue({ id: 's1', org_account_id: ORG_A });
      db.update.mockResolvedValue({});

      await site_service.update_site_into_db(
        makeReq({ params: { id: 's1' }, body: { name: 'New HQ', org_account_id: 'other-org' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
    });
  });

  describe('get_all_site_from_db', () => {
    it('filters by caller org', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await site_service.get_all_site_from_db(makeReq({ query: {} }));

      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({ org_account_id: ORG_A });
    });
  });

  describe('get_single_site_from_db', () => {
    it('includes org_account_id in WHERE clause', async () => {
      db.findUnique.mockResolvedValue({ id: 's1', org_account_id: ORG_A });

      await site_service.get_single_site_from_db(makeReq({ params: { id: 's1' } }));

      expect(db.findUnique).toHaveBeenCalledWith({
        where: { id: 's1', org_account_id: ORG_A },
      });
    });
  });

  describe('create_site_into_db', () => {
    it('injects org_account_id into the created record', async () => {
      db.create.mockResolvedValue({});

      await site_service.create_site_into_db(makeReq({ body: { name: 'HQ' } }));

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
    });
  });

  describe('update_site_into_db', () => {
    it('verifies ownership before updating', async () => {
      db.findFirst.mockResolvedValue({ id: 's1', org_account_id: ORG_A });
      db.update.mockResolvedValue({});

      await site_service.update_site_into_db(
        makeReq({ params: { id: 's1' }, body: { name: 'New HQ' } }),
      );

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 's1', org_account_id: ORG_A } });
      expect(db.update).toHaveBeenCalled();
    });

    it('throws 404 and does NOT update another org site', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        site_service.update_site_into_db(makeReq({ params: { id: 'org-b-site' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('delete_site_from_db', () => {
    it('includes org_account_id in WHERE clause', async () => {
      db.delete.mockResolvedValue({});

      await site_service.delete_site_from_db(makeReq({ params: { id: 's1' } }));

      expect(db.delete).toHaveBeenCalledWith({ where: { id: 's1', org_account_id: ORG_A } });
    });
  });
});
