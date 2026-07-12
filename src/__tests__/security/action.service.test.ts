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
    orgMember: {
      findUnique: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
    inspectionAssignment: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { action_service } from '../../app/modules/action/action.service.js';

const db = prisma.action as unknown as Record<string, ReturnType<typeof vi.fn>>;
const dbInspection = prisma.inspection as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const assignmentDb = prisma.inspectionAssignment as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;

describe('action service — org scoping (ticket #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row — pre-slice-3 tests expect the
    // backward-compat ADMIN-of-self fallback (org anchor === caller's own
    // accountId).
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

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

  describe('role scoping (issue #55 slice 3)', () => {
    const ANCHOR = 'anchor-account-00000000-0000-0000-0000-000000000009';
    const ORG_ID = 'org-00000000-0000-0000-0000-000000000009';
    const MEMBER_ID = 'org-member-00000000-0000-0000-0000-000000000009';

    const mockMembership = (role: 'ADMIN' | 'LEAD_AUDITOR' | 'LIGHT_USER' | 'VIEWER') => {
      orgMemberDb.findUnique.mockResolvedValue({
        id: MEMBER_ID,
        organizationId: ORG_ID,
        accountId: ORG_A,
        role,
      });
      organizationDb.findUnique.mockResolvedValue({
        id: ORG_ID,
        anchorAccountId: ANCHOR,
      });
    };

    it('ADMIN with a real OrgMember row still sees the whole org', async () => {
      mockMembership('ADMIN');
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      const [findArg] = db.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ orgAccountId: ANCHOR });
      expect(findArg.where.inspectionId).toBeUndefined();
      expect(assignmentDb.findMany).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR list is restricted via inspectionId to their assigned inspections', async () => {
      mockMembership('LEAD_AUDITOR');
      assignmentDb.findMany.mockResolvedValue([
        { inspectionId: 'insp-assigned-1' },
        { inspectionId: 'insp-assigned-2' },
      ]);
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      expect(assignmentDb.findMany).toHaveBeenCalledWith({
        where: { orgMemberId: MEMBER_ID },
        select: { inspectionId: true },
      });
      const [findArg] = db.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({
        orgAccountId: ANCHOR,
        inspectionId: { in: ['insp-assigned-1', 'insp-assigned-2'] },
      });
    });

    it('LEAD_AUDITOR requesting an action from an unassigned inspection gets nothing back', async () => {
      mockMembership('LEAD_AUDITOR');
      assignmentDb.findMany.mockResolvedValue([]);
      db.findFirst.mockResolvedValue(null);

      await expect(
        action_service.get_single_action_from_db(makeReq({ params: { id: 'action-1' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      const [findArg] = db.findFirst.mock.calls[0];
      expect(findArg.where.inspectionId).toEqual({ in: [] });
    });

    it('VIEWER with zero InspectionAssignment rows sees the whole org', async () => {
      mockMembership('VIEWER');
      assignmentDb.findMany.mockResolvedValue([]);
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      const [findArg] = db.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ orgAccountId: ANCHOR });
      expect(findArg.where.inspectionId).toBeUndefined();
    });

    it('VIEWER with 1+ InspectionAssignment rows is scoped the same way Lead Auditor is', async () => {
      mockMembership('VIEWER');
      assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      const [findArg] = db.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ inspectionId: { in: ['insp-assigned-1'] } });
    });

    it('LIGHT_USER gets nothing back (deny by default)', async () => {
      mockMembership('LIGHT_USER');
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      const [findArg] = db.findMany.mock.calls[0];
      expect(findArg.where.inspectionId).toEqual({ in: [] });
      expect(assignmentDb.findMany).not.toHaveBeenCalled();
    });

    it('a caller with no OrgMember row falls back to full ADMIN-equivalent access', async () => {
      orgMemberDb.findUnique.mockResolvedValue(null);
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      const [findArg] = db.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ orgAccountId: ORG_A });
      expect(findArg.where.inspectionId).toBeUndefined();
      expect(organizationDb.findUnique).not.toHaveBeenCalled();
    });

    describe('write-path scoping (create/update/delete)', () => {
      it('LEAD_AUDITOR assigned to the parent inspection can create a finding on it', async () => {
        mockMembership('LEAD_AUDITOR');
        assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
        dbInspection.findFirst.mockResolvedValue({
          id: 'insp-assigned-1',
          siteId: 'site-1',
          orgAccountId: ANCHOR,
        });
        db.create.mockResolvedValue({});

        await action_service.create_action_into_db(
          makeReq({ body: { inspectionId: 'insp-assigned-1', title: 'Found it' } }),
        );

        expect(db.create).toHaveBeenCalled();
      });

      it('LEAD_AUDITOR NOT assigned to the parent inspection cannot create a finding on it', async () => {
        mockMembership('LEAD_AUDITOR');
        assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
        dbInspection.findFirst.mockResolvedValue({
          id: 'insp-not-assigned',
          siteId: 'site-1',
          orgAccountId: ANCHOR,
        });

        await expect(
          action_service.create_action_into_db(
            makeReq({ body: { inspectionId: 'insp-not-assigned', title: 'Nope' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(db.create).not.toHaveBeenCalled();
      });

      it('VIEWER can never create a finding', async () => {
        mockMembership('VIEWER');
        dbInspection.findFirst.mockResolvedValue({
          id: 'insp-1',
          siteId: 'site-1',
          orgAccountId: ANCHOR,
        });

        await expect(
          action_service.create_action_into_db(
            makeReq({ body: { inspectionId: 'insp-1', title: 'Nope' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(db.create).not.toHaveBeenCalled();
      });

      it("LEAD_AUDITOR NOT assigned to the finding's parent inspection cannot update it", async () => {
        mockMembership('LEAD_AUDITOR');
        assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
        db.findFirst.mockResolvedValue({
          id: 'a1',
          inspectionId: 'insp-not-assigned',
          orgAccountId: ANCHOR,
        });

        await expect(
          action_service.update_action_into_db(
            makeReq({ params: { id: 'a1' }, body: { actionTitle: 'Updated' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(db.update).not.toHaveBeenCalled();
      });

      it("LEAD_AUDITOR assigned to the finding's parent inspection can delete it", async () => {
        mockMembership('LEAD_AUDITOR');
        assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
        db.findFirst.mockResolvedValue({
          id: 'a1',
          inspectionId: 'insp-assigned-1',
          orgAccountId: ANCHOR,
        });
        db.delete.mockResolvedValue({});

        await action_service.delete_action_from_db(makeReq({ params: { id: 'a1' } }));

        expect(db.delete).toHaveBeenCalled();
      });

      it('ADMIN can create/update/delete findings regardless of assignment', async () => {
        mockMembership('ADMIN');
        dbInspection.findFirst.mockResolvedValue({
          id: 'insp-1',
          siteId: 'site-1',
          orgAccountId: ANCHOR,
        });
        db.create.mockResolvedValue({});
        db.findFirst.mockResolvedValue({ id: 'a1', inspectionId: 'insp-1', orgAccountId: ANCHOR });
        db.update.mockResolvedValue({});
        db.delete.mockResolvedValue({});

        await action_service.create_action_into_db(
          makeReq({ body: { inspectionId: 'insp-1', title: 'Found it' } }),
        );
        expect(db.create).toHaveBeenCalled();

        await action_service.update_action_into_db(
          makeReq({ params: { id: 'a1' }, body: { actionTitle: 'Updated' } }),
        );
        expect(db.update).toHaveBeenCalled();

        await action_service.delete_action_from_db(makeReq({ params: { id: 'a1' } }));
        expect(db.delete).toHaveBeenCalled();
        expect(assignmentDb.findMany).not.toHaveBeenCalled();
      });
    });
  });
});
