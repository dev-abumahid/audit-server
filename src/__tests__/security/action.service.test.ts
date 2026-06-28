import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, ORG_B, makeReq } from '../helpers/makeReq.js';

// Mock Prisma before importing the service
vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    action: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    inspection: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { action_service } from '../../app/modules/action/action.service.js';

const db = prisma.action as unknown as Record<string, ReturnType<typeof vi.fn>>;
const dbInspection = prisma.inspection as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('action service — org scoping (ticket #6)', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── getAll ───────────────────────────────────────────────────────────────
  describe('get_all_action_from_db', () => {
    it('filters findMany by caller org', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orgAccountId: ORG_A } }),
      );
    });

    it('never returns records from a different org', async () => {
      const orgARecord = { id: 'a1', orgAccountId: ORG_A };
      db.findMany.mockResolvedValue([orgARecord]);
      db.count.mockResolvedValue(1);

      const result = await action_service.get_all_action_from_db(makeReq());

      expect(result.data).toEqual([orgARecord]);
      expect(result.data.every((r: any) => r.orgAccountId === ORG_A)).toBe(true);
    });
  });

  // ── getSingle ─────────────────────────────────────────────────────────────
  describe('get_single_action_from_db', () => {
    it('includes orgAccountId in WHERE clause', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });

      await action_service.get_single_action_from_db(makeReq({ params: { id: 'a1' } }));

      expect(db.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'a1', orgAccountId: ORG_A } }),
      );
    });

    it('throws 404 when record belongs to another org (Prisma returns null)', async () => {
      db.findFirst.mockResolvedValue(null); // Prisma finds nothing for wrong org

      await expect(
        action_service.get_single_action_from_db(makeReq({ params: { id: 'org-b-action' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('does not throw when record belongs to caller org', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });

      await expect(
        action_service.get_single_action_from_db(makeReq({ params: { id: 'a1' } })),
      ).resolves.toBeDefined();
    });
  });

  // ── create ────────────────────────────────────────────────────────────────
  describe('create_action_into_db', () => {
    it('injects orgAccountId into the created record', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      db.create.mockResolvedValue({ id: 'new', orgAccountId: ORG_A });

      await action_service.create_action_into_db(
        makeReq({ body: { inspectionId: 'insp-1', title: 'Mitigate risk' } }),
      );

      expect(db.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ orgAccountId: ORG_A }) }),
      );
    });

    it('verifies inspection belongs to caller org before creating action', async () => {
      dbInspection.findFirst.mockResolvedValue(null); // org-B inspection not found for org-A

      await expect(
        action_service.create_action_into_db(
          makeReq({ body: { inspectionId: 'org-b-insp', title: 'Evil' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('does not let the client override orgAccountId', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      db.create.mockResolvedValue({});

      await action_service.create_action_into_db(
        makeReq({ body: { inspectionId: 'insp-1', title: 'Evil', orgAccountId: ORG_B } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.orgAccountId).toBe(ORG_A); // always caller, never body value
    });
  });

  // ── update ────────────────────────────────────────────────────────────────
  describe('update_action_into_db', () => {
    it('verifies ownership before updating', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      db.update.mockResolvedValue({});

      await action_service.update_action_into_db(
        makeReq({ params: { id: 'a1' }, body: { title: 'Updated' } }),
      );

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'a1', orgAccountId: ORG_A } });
      expect(db.update).toHaveBeenCalled();
    });

    it('throws 404 and does NOT update when record belongs to another org', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        action_service.update_action_into_db(
          makeReq({ params: { id: 'org-b-action' }, body: { title: 'Tampered' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  // ── delete ────────────────────────────────────────────────────────────────
  describe('delete_action_from_db', () => {
    it('verifies ownership before deleting', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      db.delete.mockResolvedValue({});

      await action_service.delete_action_from_db(makeReq({ params: { id: 'a1' } }));

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'a1', orgAccountId: ORG_A } });
      expect(db.delete).toHaveBeenCalled();
    });

    it('throws 404 and does NOT delete when record belongs to another org', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        action_service.delete_action_from_db(makeReq({ params: { id: 'org-b-action' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.delete).not.toHaveBeenCalled();
    });
  });
});
