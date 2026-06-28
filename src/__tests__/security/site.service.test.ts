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
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { site_service } from '../../app/modules/site/site.service.js';

const db = prisma.site as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('site service — org scoping (ticket #6)', () => {
  beforeEach(() => vi.clearAllMocks());

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
