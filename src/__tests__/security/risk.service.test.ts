import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, ORG_B, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    risk: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { risk_service } from '../../app/modules/risk/risk.service.js';

const db = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('risk service — org scoping (ticket #6)', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('get_all_risk_from_db', () => {
    it('filters by caller org', async () => {
      db.findMany.mockResolvedValue([]);

      await risk_service.get_all_risk_from_db(makeReq());

      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({ org_account_id: ORG_A });
    });
  });

  describe('get_single_risk_from_db', () => {
    it('includes org_account_id in WHERE clause', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });

      await risk_service.get_single_risk_from_db(makeReq({ params: { id: 'r1' } }));

      expect(db.findFirst).toHaveBeenCalledWith({
        where: { id: 'r1', org_account_id: ORG_A },
      });
    });

    it('throws 404 for another org risk', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        risk_service.get_single_risk_from_db(makeReq({ params: { id: 'org-b-risk' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('create_risk_into_db', () => {
    it('injects org_account_id into the created record', async () => {
      db.create.mockResolvedValue({});

      await risk_service.create_risk_into_db(makeReq({ body: { name: 'Cyber risk' } }));

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
    });

    it('overwrites any org_account_id supplied in the request body', async () => {
      db.create.mockResolvedValue({});

      await risk_service.create_risk_into_db(
        makeReq({ body: { name: 'Evil', org_account_id: ORG_B } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
    });
  });

  describe('update_risk_into_db', () => {
    it('verifies ownership before updating', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.update.mockResolvedValue({});

      await risk_service.update_risk_into_db(makeReq({ params: { id: 'r1' } }));

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'r1', org_account_id: ORG_A } });
    });

    it('throws 404 and does NOT update another org risk', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        risk_service.update_risk_into_db(makeReq({ params: { id: 'org-b-risk' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('delete_risk_from_db', () => {
    it('verifies ownership before deleting', async () => {
      db.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.delete.mockResolvedValue({});

      await risk_service.delete_risk_from_db(makeReq({ params: { id: 'r1' } }));

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'r1', org_account_id: ORG_A } });
    });

    it('throws 404 and does NOT delete another org risk', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        risk_service.delete_risk_from_db(makeReq({ params: { id: 'org-b-risk' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.delete).not.toHaveBeenCalled();
    });
  });
});
