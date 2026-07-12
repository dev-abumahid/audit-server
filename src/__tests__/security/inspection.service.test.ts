import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    inspection: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    template: {
      findFirst: vi.fn(),
    },
    site: {
      findFirst: vi.fn(),
    },
    note: {
      findUnique: vi.fn(),
    },
    questionAnswer: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    orgMember: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
    inspectionAssignment: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { inspection_service } from '../../app/modules/inspection/inspection.service.js';

const inspectionDb = prisma.inspection as unknown as Record<string, ReturnType<typeof vi.fn>>;
const noteDb = prisma.note as unknown as Record<string, ReturnType<typeof vi.fn>>;
const templateDb = prisma.template as unknown as Record<string, ReturnType<typeof vi.fn>>;
const siteDb = prisma.site as unknown as Record<string, ReturnType<typeof vi.fn>>;
const qaDb = prisma.questionAnswer as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const assignmentDb = prisma.inspectionAssignment as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;

describe('inspection service — org scoping (ticket #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row — every pre-existing test in this file
    // predates slice 3's role scoping and expects the backward-compat
    // ADMIN-of-self fallback (org anchor === caller's own accountId, same
    // as the pre-slice-3 behavior).
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  describe('get_all_inspection_from_db', () => {
    it('filters by caller org', async () => {
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      const [countArg] = inspectionDb.count.mock.calls[0];
      expect(countArg.where).toMatchObject({ orgAccountId: ORG_A });

      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ orgAccountId: ORG_A });
    });
  });

  describe('get_single_inspection_from_db', () => {
    it('includes orgAccountId in WHERE clause', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'i1', orgAccountId: ORG_A });

      await inspection_service.get_single_inspection_from_db(makeReq({ params: { id: 'i1' } }));

      const [callArg] = inspectionDb.findFirst.mock.calls[0];
      expect(callArg.where).toMatchObject({ id: 'i1', orgAccountId: ORG_A });
    });

    it('throws 404 for another org inspection', async () => {
      inspectionDb.findFirst.mockResolvedValue(null);

      await expect(
        inspection_service.get_single_inspection_from_db(
          makeReq({ params: { id: 'org-b-inspection' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('create_inspection_into_db', () => {
    it('injects orgAccountId into the created record', async () => {
      templateDb.findFirst.mockResolvedValue({
        id: 't1',
        orgAccountId: ORG_A,
      });

      siteDb.findFirst.mockResolvedValue({
        id: 's1',
        org_account_id: ORG_A,
      });

      inspectionDb.create.mockResolvedValue({});

      await inspection_service.create_inspection_into_db(
        makeReq({
          body: {
            templateId: 't1',
            siteId: 's1',
            inspectorProfileId: 'p1',
            questionAnswers: [],
          },
        }),
      );

      const callArg = inspectionDb.create.mock.calls[0][0];
      expect(callArg.data.orgAccountId).toBe(ORG_A);
    });

    it('throws 404 and does NOT create when the templateId belongs to another org', async () => {
      templateDb.findFirst.mockResolvedValue(null);
      siteDb.findFirst.mockResolvedValue({ id: 's1', org_account_id: ORG_A });

      await expect(
        inspection_service.create_inspection_into_db(
          makeReq({
            body: {
              templateId: 'org-b-template',
              siteId: 's1',
              inspectorProfileId: 'p1',
              questionAnswers: [],
            },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(inspectionDb.create).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT create when the siteId belongs to another org', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      siteDb.findFirst.mockResolvedValue(null);

      await expect(
        inspection_service.create_inspection_into_db(
          makeReq({
            body: {
              templateId: 't1',
              siteId: 'org-b-site',
              inspectorProfileId: 'p1',
              questionAnswers: [],
            },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(inspectionDb.create).not.toHaveBeenCalled();
    });
  });

  describe('update_inspection_into_db', () => {
    it('verifies ownership before updating', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'i1', orgAccountId: ORG_A });
      inspectionDb.update.mockResolvedValue({});

      await inspection_service.update_inspection_into_db(
        makeReq({ params: { id: 'i1' }, body: {} }),
      );

      expect(inspectionDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'i1', orgAccountId: ORG_A },
      });
    });

    it('throws 404 and does NOT update another org inspection', async () => {
      inspectionDb.findFirst.mockResolvedValue(null);

      await expect(
        inspection_service.update_inspection_into_db(makeReq({ params: { id: 'org-b-insp' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(inspectionDb.update).not.toHaveBeenCalled();
    });
  });

  describe('delete_inspection_from_db', () => {
    it('verifies ownership before deleting', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'i1', orgAccountId: ORG_A });
      inspectionDb.delete.mockResolvedValue({});

      await inspection_service.delete_inspection_from_db(makeReq({ params: { id: 'i1' } }));

      expect(inspectionDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'i1', orgAccountId: ORG_A },
      });
    });

    it('throws 404 and does NOT delete another org inspection', async () => {
      inspectionDb.findFirst.mockResolvedValue(null);

      await expect(
        inspection_service.delete_inspection_from_db(makeReq({ params: { id: 'org-b-insp' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(inspectionDb.delete).not.toHaveBeenCalled();
    });
  });

  describe('update_inspection_question_into_db — org scoping via parent inspection', () => {
    it('verifies question belongs to caller org via inspection.orgAccountId', async () => {
      qaDb.findUnique.mockResolvedValue({
        inspection: { orgAccountId: ORG_A },
      });
      qaDb.update.mockResolvedValue({});

      await inspection_service.update_inspection_question_into_db(
        makeReq({ params: { id: 'qa1' }, body: { answer: 'Yes' } }),
      );

      expect(qaDb.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'qa1' } }),
      );
      expect(qaDb.update).toHaveBeenCalled();
    });

    it('throws 404 when question belongs to another org inspection', async () => {
      qaDb.findUnique.mockResolvedValue({
        inspection: { orgAccountId: 'some-other-org' },
      });

      await expect(
        inspection_service.update_inspection_question_into_db(
          makeReq({ params: { id: 'org-b-qa' }, body: {} }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(qaDb.update).not.toHaveBeenCalled();
    });

    it('throws 404 when question answer does not exist at all', async () => {
      qaDb.findUnique.mockResolvedValue(null);

      await expect(
        inspection_service.update_inspection_question_into_db(
          makeReq({ params: { id: 'nonexistent' }, body: {} }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('split_note_into_inspection_using_ai (ticket #23)', () => {
    it('scopes both the note and inspection lookups by org', async () => {
      noteDb.findUnique.mockResolvedValue({ extracted_text: 'text' });
      inspectionDb.findUnique.mockResolvedValue({ questionAnswers: [] });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
      );

      await inspection_service.split_note_into_inspection_using_ai(
        makeReq({ params: { inspectionId: 'insp-1' } }),
      );

      expect(noteDb.findUnique).toHaveBeenCalledWith({
        where: { inspectionId: 'insp-1', orgAccountId: ORG_A },
        select: { extracted_text: true },
      });
      expect(inspectionDb.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'insp-1', orgAccountId: ORG_A },
        }),
      );
    });

    it('throws 404 when the inspection belongs to another org', async () => {
      noteDb.findUnique.mockResolvedValue({ extracted_text: 'text' });
      inspectionDb.findUnique.mockResolvedValue(null);

      await expect(
        inspection_service.split_note_into_inspection_using_ai(
          makeReq({ params: { inspectionId: 'org-b-insp' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 404 when the note belongs to another org', async () => {
      noteDb.findUnique.mockResolvedValue(null);
      inspectionDb.findUnique.mockResolvedValue({ questionAnswers: [] });

      await expect(
        inspection_service.split_note_into_inspection_using_ai(
          makeReq({ params: { inspectionId: 'insp-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
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
        status: 'ACTIVE',
        expiresAt: null,
      });
      organizationDb.findUnique.mockResolvedValue({
        id: ORG_ID,
        anchorAccountId: ANCHOR,
      });
    };

    it('ADMIN with a real OrgMember row still sees the whole org (anchor account, no id restriction)', async () => {
      mockMembership('ADMIN');
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ orgAccountId: ANCHOR });
      expect(findArg.where.id).toBeUndefined();
      expect(assignmentDb.findMany).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR list is restricted to their assigned inspection ids', async () => {
      mockMembership('LEAD_AUDITOR');
      assignmentDb.findMany.mockResolvedValue([
        { inspectionId: 'insp-assigned-1' },
        { inspectionId: 'insp-assigned-2' },
      ]);
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      expect(assignmentDb.findMany).toHaveBeenCalledWith({
        where: { orgMemberId: MEMBER_ID },
        select: { inspectionId: true },
      });
      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({
        orgAccountId: ANCHOR,
        id: { in: ['insp-assigned-1', 'insp-assigned-2'] },
      });
    });

    it('LEAD_AUDITOR requesting an inspection they are NOT assigned to gets nothing back', async () => {
      mockMembership('LEAD_AUDITOR');
      assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
      inspectionDb.findFirst.mockResolvedValue(null);

      await expect(
        inspection_service.get_single_inspection_from_db(
          makeReq({ params: { id: 'insp-not-assigned' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      const [findArg] = inspectionDb.findFirst.mock.calls[0];
      // The requested id isn't in the assigned set, so the id filter
      // collapses to an impossible match rather than the raw requested id.
      expect(findArg.where.id).toEqual({ in: [] });
    });

    it('LEAD_AUDITOR requesting an assigned inspection is allowed through', async () => {
      mockMembership('LEAD_AUDITOR');
      assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
      inspectionDb.findFirst.mockResolvedValue({ id: 'insp-assigned-1' });

      await inspection_service.get_single_inspection_from_db(
        makeReq({ params: { id: 'insp-assigned-1' } }),
      );

      const [findArg] = inspectionDb.findFirst.mock.calls[0];
      expect(findArg.where.id).toBe('insp-assigned-1');
    });

    it('VIEWER with zero InspectionAssignment rows sees the whole org', async () => {
      mockMembership('VIEWER');
      assignmentDb.findMany.mockResolvedValue([]);
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ orgAccountId: ANCHOR });
      expect(findArg.where.id).toBeUndefined();
    });

    it('VIEWER with 1+ InspectionAssignment rows is scoped the same way Lead Auditor is', async () => {
      mockMembership('VIEWER');
      assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ id: { in: ['insp-assigned-1'] } });
    });

    it('LIGHT_USER gets nothing back (deny by default — real scoping ships in slice 4)', async () => {
      mockMembership('LIGHT_USER');
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where.id).toEqual({ in: [] });
      // Light User scoping doesn't need InspectionAssignment lookups at all.
      expect(assignmentDb.findMany).not.toHaveBeenCalled();
    });

    it('a caller with no OrgMember row falls back to full ADMIN-equivalent access', async () => {
      orgMemberDb.findUnique.mockResolvedValue(null);
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ orgAccountId: ORG_A });
      expect(findArg.where.id).toBeUndefined();
      expect(organizationDb.findUnique).not.toHaveBeenCalled();
    });

    it('inspection creation is ADMIN-only', async () => {
      mockMembership('LEAD_AUDITOR');

      await expect(
        inspection_service.create_inspection_into_db(
          makeReq({
            body: { templateId: 't1', siteId: 's1', inspectorProfileId: 'p1', questionAnswers: [] },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(inspectionDb.create).not.toHaveBeenCalled();
    });

    describe('write-path scoping (update/delete)', () => {
      it('LEAD_AUDITOR assigned to the inspection can update it', async () => {
        mockMembership('LEAD_AUDITOR');
        assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-assigned-1', orgAccountId: ANCHOR });
        inspectionDb.update.mockResolvedValue({});

        await inspection_service.update_inspection_into_db(
          makeReq({ params: { id: 'insp-assigned-1' }, body: { status: 'COMPLETE' } }),
        );

        expect(inspectionDb.update).toHaveBeenCalled();
      });

      it('LEAD_AUDITOR NOT assigned to the inspection is rejected on update, even though it exists in their org', async () => {
        mockMembership('LEAD_AUDITOR');
        assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-not-assigned', orgAccountId: ANCHOR });

        await expect(
          inspection_service.update_inspection_into_db(
            makeReq({ params: { id: 'insp-not-assigned' }, body: { status: 'COMPLETE' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(inspectionDb.update).not.toHaveBeenCalled();
      });

      it('VIEWER can never update an inspection, even one in their scope', async () => {
        mockMembership('VIEWER');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });

        await expect(
          inspection_service.update_inspection_into_db(
            makeReq({ params: { id: 'insp-1' }, body: { status: 'COMPLETE' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(inspectionDb.update).not.toHaveBeenCalled();
      });

      it('LEAD_AUDITOR cannot delete an inspection even if assigned to it — deletion stays ADMIN-only', async () => {
        mockMembership('LEAD_AUDITOR');
        assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-assigned-1', orgAccountId: ANCHOR });

        await expect(
          inspection_service.delete_inspection_from_db(
            makeReq({ params: { id: 'insp-assigned-1' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(inspectionDb.delete).not.toHaveBeenCalled();
      });

      it('ADMIN can update and delete any inspection in the org regardless of assignment', async () => {
        mockMembership('ADMIN');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });
        inspectionDb.update.mockResolvedValue({});
        inspectionDb.delete.mockResolvedValue({});

        await inspection_service.update_inspection_into_db(
          makeReq({ params: { id: 'insp-1' }, body: { status: 'COMPLETE' } }),
        );
        expect(inspectionDb.update).toHaveBeenCalled();

        await inspection_service.delete_inspection_from_db(makeReq({ params: { id: 'insp-1' } }));
        expect(inspectionDb.delete).toHaveBeenCalled();
        expect(assignmentDb.findMany).not.toHaveBeenCalled();
      });
    });

    describe('assignment endpoints — the mechanism that actually creates InspectionAssignment rows', () => {
      it('ADMIN can assign a member to an inspection', async () => {
        mockMembership('ADMIN');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });
        (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
          .fn()
          .mockResolvedValue({ id: 'target-member', organizationId: ORG_ID });
        assignmentDb.upsert.mockResolvedValue({
          orgMemberId: 'target-member',
          inspectionId: 'insp-1',
        });

        const result = await inspection_service.assign_member_to_inspection(
          makeReq({ params: { id: 'insp-1' }, body: { orgMemberId: 'target-member' } }),
        );

        expect(assignmentDb.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              orgMemberId_inspectionId: { orgMemberId: 'target-member', inspectionId: 'insp-1' },
            },
          }),
        );
        expect(result).toMatchObject({ orgMemberId: 'target-member', inspectionId: 'insp-1' });
      });

      it('non-ADMIN cannot assign anyone to an inspection', async () => {
        mockMembership('LEAD_AUDITOR');

        await expect(
          inspection_service.assign_member_to_inspection(
            makeReq({ params: { id: 'insp-1' }, body: { orgMemberId: 'target-member' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(assignmentDb.upsert).not.toHaveBeenCalled();
      });

      it("rejects assigning a member who does not belong to the caller's org", async () => {
        mockMembership('ADMIN');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });
        (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
          .fn()
          .mockResolvedValue(null);

        await expect(
          inspection_service.assign_member_to_inspection(
            makeReq({ params: { id: 'insp-1' }, body: { orgMemberId: 'someone-elses-member' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 404 });

        expect(assignmentDb.upsert).not.toHaveBeenCalled();
      });

      it('ADMIN can unassign a member from an inspection', async () => {
        mockMembership('ADMIN');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });
        assignmentDb.deleteMany.mockResolvedValue({ count: 1 });

        await inspection_service.unassign_member_from_inspection(
          makeReq({ params: { id: 'insp-1', orgMemberId: 'target-member' } }),
        );

        expect(assignmentDb.deleteMany).toHaveBeenCalledWith({
          where: { orgMemberId: 'target-member', inspectionId: 'insp-1' },
        });
      });

      it('non-ADMIN cannot unassign anyone', async () => {
        mockMembership('VIEWER');

        await expect(
          inspection_service.unassign_member_from_inspection(
            makeReq({ params: { id: 'insp-1', orgMemberId: 'target-member' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(assignmentDb.deleteMany).not.toHaveBeenCalled();
      });
    });
  });
});
