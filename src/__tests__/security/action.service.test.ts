import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, ORG_B, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/utils/cloudinary.js', () => ({
  default: vi.fn(),
}));

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
    question: {
      findFirst: vi.fn(),
    },
    orgMember: {
      findUnique: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    inspectionAssignment: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    findingAssignment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    orgAuditLog: {
      create: vi.fn(),
    },
    externalOrgMember: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { action_service } from '../../app/modules/action/action.service.js';
import uploadCloud from '../../app/utils/cloudinary.js';

const mockUploadCloud = vi.mocked(uploadCloud);

const db = prisma.action as unknown as Record<string, ReturnType<typeof vi.fn>>;
const dbInspection = prisma.inspection as unknown as Record<string, ReturnType<typeof vi.fn>>;
const dbQuestion = prisma.question as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const assignmentDb = prisma.inspectionAssignment as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const findingAssignmentDb = prisma.findingAssignment as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const externalOrgMemberDb = prisma.externalOrgMember as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;

// requireCallerOrganizationId needs a real OrgMember row for the caller
// (ctx.orgMemberId non-null) to resolve the real Organization.id -- the
// default beforeEach mock (orgMemberDb.findUnique -> null) is the
// ADMIN-of-self fallback, which has no real Organization to resolve. Used
// by every assignBy test below that needs the org-scope check to actually
// run rather than short-circuit on an empty array.
const REAL_ORG_ID = 'real-org-00000000-0000-0000-0000-000000000099';
const mockRealOrgMembership = () => {
  orgMemberDb.findUnique.mockResolvedValue({
    id: 'caller-member-00000000-0000-0000-0000-000000000099',
    organizationId: REAL_ORG_ID,
    accountId: ORG_A,
    role: 'ADMIN',
    status: 'ACTIVE',
    expiresAt: null,
  });
  organizationDb.findUnique.mockResolvedValue({ id: REAL_ORG_ID, anchorAccountId: ORG_A });
};

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

      // shapeResponsibleAssignees adds assignBy: [] (no responsibleAssignees
      // in this mock's minimal record) — the org-scoping assertion this test
      // actually cares about is the second line below.
      expect(result.data).toEqual([{ ...orgARecord, assignBy: [] }]);
      expect(result.data.every((r: any) => r.orgAccountId === ORG_A)).toBe(true);
    });

    it('includes inspectionId in the WHERE clause when provided', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq({ query: { inspectionId: 'insp-1' } }));

      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgAccountId: ORG_A, inspectionId: 'insp-1' },
        }),
      );
    });

    it('does not filter by inspectionId when not provided', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      const callArg = db.findMany.mock.calls[0][0];
      expect(callArg.where).not.toHaveProperty('inspectionId');
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

    it('shapes responsibleAssignees into assignBy: {id, name}[] (issue #52)', async () => {
      db.findFirst.mockResolvedValue({
        id: 'a1',
        orgAccountId: ORG_A,
        responsibleAssignees: [
          {
            orgMemberId: 'member-1',
            orgMember: { account: { email: 'a@x.com', profile: { fullName: 'Alice' } } },
          },
          {
            // No profile row -- falls back to email, same pattern already
            // used for member lists elsewhere in this codebase.
            orgMemberId: 'member-2',
            orgMember: { account: { email: 'b@x.com', profile: null } },
          },
        ],
      });

      const result = await action_service.get_single_action_from_db(
        makeReq({ params: { id: 'a1' } }),
      );

      expect(result.assignBy).toEqual([
        { id: 'member-1', name: 'Alice' },
        { id: 'member-2', name: 'b@x.com' },
      ]);
      expect(result).not.toHaveProperty('responsibleAssignees');
    });

    it('returns an empty assignBy array when no one is assigned', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A, responsibleAssignees: [] });

      const result = await action_service.get_single_action_from_db(
        makeReq({ params: { id: 'a1' } }),
      );

      expect(result.assignBy).toEqual([]);
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

    it('allows creating an action with no questionId at all (it is optional)', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      db.create.mockResolvedValue({});

      await action_service.create_action_into_db(
        makeReq({ body: { inspectionId: 'insp-1', title: 'No question' } }),
      );

      expect(dbQuestion.findFirst).not.toHaveBeenCalled();
      expect(db.create).toHaveBeenCalled();
    });

    it('verifies questionId belongs to the caller org before creating action (issue #50)', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      dbQuestion.findFirst.mockResolvedValue({ id: 'q1' });
      db.create.mockResolvedValue({});

      await action_service.create_action_into_db(
        makeReq({ body: { inspectionId: 'insp-1', title: 'Has question', questionId: 'q1' } }),
      );

      expect(dbQuestion.findFirst).toHaveBeenCalledWith({
        where: { id: 'q1', page: { template: { orgAccountId: ORG_A } } },
      });
      expect(db.create).toHaveBeenCalled();
    });

    it('throws 404 and does NOT create when questionId belongs to another org (issue #50)', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      dbQuestion.findFirst.mockResolvedValue(null); // org-B question not found for org-A

      await expect(
        action_service.create_action_into_db(
          makeReq({
            body: { inspectionId: 'insp-1', title: 'IDOR attempt', questionId: 'org-b-question' },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('persists attachments when provided', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      db.create.mockResolvedValue({});

      await action_service.create_action_into_db(
        makeReq({
          body: {
            inspectionId: 'insp-1',
            title: 'With attachment',
            attachments: ['https://s3/one.jpg'],
          },
        }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.attachments).toEqual(['https://s3/one.jpg']);
    });

    it('defaults attachments to an empty array when not provided', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      db.create.mockResolvedValue({});

      await action_service.create_action_into_db(
        makeReq({ body: { inspectionId: 'insp-1', title: 'No attachment' } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.attachments).toEqual([]);
    });

    it('creates responsibleAssignees rows for valid assignBy ids (issue #52)', async () => {
      mockRealOrgMembership();
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      orgMemberDb.findMany = vi
        .fn()
        .mockResolvedValue([{ id: 'member-1', organizationId: REAL_ORG_ID }]);
      db.create.mockResolvedValue({});

      await action_service.create_action_into_db(
        makeReq({
          body: { inspectionId: 'insp-1', title: 'Assigned', assignBy: ['member-1'] },
        }),
      );

      // The real Organization.id, NOT ctx.organizationId (ORG_A, the anchor
      // Account.id) -- passing the wrong one here 404s every legitimate
      // assignBy id in production (found by independent review). A single
      // batched findMany (issue #135), not one findFirst per assignee.
      expect(orgMemberDb.findMany).toHaveBeenCalledTimes(1);
      expect(orgMemberDb.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['member-1'] }, organizationId: REAL_ORG_ID },
      });
      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.responsibleAssignees).toEqual({
        create: [{ orgMemberId: 'member-1' }],
      });
    });

    it('batches multiple assignee ids into a single findMany call, not one query per id (issue #135)', async () => {
      mockRealOrgMembership();
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      orgMemberDb.findMany = vi.fn().mockResolvedValue([
        { id: 'member-1', organizationId: REAL_ORG_ID },
        { id: 'member-2', organizationId: REAL_ORG_ID },
        { id: 'member-3', organizationId: REAL_ORG_ID },
      ]);
      db.create.mockResolvedValue({});

      await action_service.create_action_into_db(
        makeReq({
          body: {
            inspectionId: 'insp-1',
            title: 'Assigned to three',
            assignBy: ['member-1', 'member-2', 'member-3'],
          },
        }),
      );

      expect(orgMemberDb.findMany).toHaveBeenCalledTimes(1);
      expect(orgMemberDb.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['member-1', 'member-2', 'member-3'] }, organizationId: REAL_ORG_ID },
      });
    });

    it('throws 404 and does NOT create when an assignBy id belongs to another org (issue #52)', async () => {
      mockRealOrgMembership();
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      // Org-B's member -- findMany scoped to the caller's real org finds nothing.
      orgMemberDb.findMany = vi.fn().mockResolvedValue([]);

      await expect(
        action_service.create_action_into_db(
          makeReq({
            body: { inspectionId: 'insp-1', title: 'IDOR attempt', assignBy: ['org-b-member'] },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT create when only SOME assignBy ids belong to the caller org', async () => {
      mockRealOrgMembership();
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      // Only member-1 is found -- member-2 (cross-org or nonexistent) is
      // missing from the batched result, so this must still 404 rather than
      // silently proceeding with a partial assignee list.
      orgMemberDb.findMany = vi
        .fn()
        .mockResolvedValue([{ id: 'member-1', organizationId: REAL_ORG_ID }]);

      await expect(
        action_service.create_action_into_db(
          makeReq({
            body: {
              inspectionId: 'insp-1',
              title: 'Partial IDOR attempt',
              assignBy: ['member-1', 'org-b-member'],
            },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('defaults responsibleAssignees to an empty create list when assignBy is not provided', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      db.create.mockResolvedValue({});

      await action_service.create_action_into_db(
        makeReq({ body: { inspectionId: 'insp-1', title: 'No assignee' } }),
      );

      expect(orgMemberDb.findMany).not.toHaveBeenCalled();
      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.responsibleAssignees).toEqual({ create: [] });
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

    it('updates attachments when provided', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      db.update.mockResolvedValue({});

      await action_service.update_action_into_db(
        makeReq({ params: { id: 'a1' }, body: { attachments: ['https://s3/two.jpg'] } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.attachments).toEqual(['https://s3/two.jpg']);
    });

    it('leaves attachments untouched when not provided', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      db.update.mockResolvedValue({});

      await action_service.update_action_into_db(
        makeReq({ params: { id: 'a1' }, body: { actionTitle: 'Renamed' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).not.toHaveProperty('attachments');
    });

    it('replaces responsibleAssignees (delete + recreate) when assignBy is provided (issue #52)', async () => {
      mockRealOrgMembership();
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      orgMemberDb.findMany = vi
        .fn()
        .mockResolvedValue([{ id: 'member-2', organizationId: REAL_ORG_ID }]);
      db.update.mockResolvedValue({});

      await action_service.update_action_into_db(
        makeReq({ params: { id: 'a1' }, body: { assignBy: ['member-2'] } }),
      );

      // Single batched findMany (issue #135), not one findFirst per assignee.
      expect(orgMemberDb.findMany).toHaveBeenCalledTimes(1);
      expect(orgMemberDb.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['member-2'] }, organizationId: REAL_ORG_ID },
      });
      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.responsibleAssignees).toEqual({
        deleteMany: {},
        create: [{ orgMemberId: 'member-2' }],
      });
    });

    it('batches multiple assignee ids into a single findMany call on update, not one query per id (issue #135)', async () => {
      mockRealOrgMembership();
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      orgMemberDb.findMany = vi.fn().mockResolvedValue([
        { id: 'member-2', organizationId: REAL_ORG_ID },
        { id: 'member-3', organizationId: REAL_ORG_ID },
      ]);
      db.update.mockResolvedValue({});

      await action_service.update_action_into_db(
        makeReq({ params: { id: 'a1' }, body: { assignBy: ['member-2', 'member-3'] } }),
      );

      expect(orgMemberDb.findMany).toHaveBeenCalledTimes(1);
      expect(orgMemberDb.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['member-2', 'member-3'] }, organizationId: REAL_ORG_ID },
      });
    });

    it('clears all assignees when assignBy is an empty array (not the same as omitted)', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      db.update.mockResolvedValue({});

      await action_service.update_action_into_db(
        makeReq({ params: { id: 'a1' }, body: { assignBy: [] } }),
      );

      expect(orgMemberDb.findMany).not.toHaveBeenCalled();
      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.responsibleAssignees).toEqual({ deleteMany: {}, create: [] });
    });

    it('leaves responsibleAssignees untouched when assignBy is not provided at all', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      db.update.mockResolvedValue({});

      await action_service.update_action_into_db(
        makeReq({ params: { id: 'a1' }, body: { actionTitle: 'Renamed' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).not.toHaveProperty('responsibleAssignees');
    });

    it('throws 404 and does NOT update when a new assignBy id belongs to another org (issue #52)', async () => {
      mockRealOrgMembership();
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      orgMemberDb.findMany = vi.fn().mockResolvedValue([]);

      await expect(
        action_service.update_action_into_db(
          makeReq({ params: { id: 'a1' }, body: { assignBy: ['org-b-member'] } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT update when only SOME new assignBy ids belong to the caller org', async () => {
      mockRealOrgMembership();
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      orgMemberDb.findMany = vi
        .fn()
        .mockResolvedValue([{ id: 'member-2', organizationId: REAL_ORG_ID }]);

      await expect(
        action_service.update_action_into_db(
          makeReq({
            params: { id: 'a1' },
            body: { assignBy: ['member-2', 'org-b-member'] },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  // ── update messages ──────────────────────────────────────────────────────
  describe('update_action_messages_into_db (issue #51)', () => {
    it('verifies ownership before adding a message', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A, inspectionId: 'insp-1' });
      db.update.mockResolvedValue({});

      await action_service.update_action_messages_into_db(
        makeReq({ params: { id: 'a1' }, body: { message: 'Hi there' } }),
      );

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'a1', orgAccountId: ORG_A } });
      expect(db.update).toHaveBeenCalled();
    });

    it('throws 404 and does NOT create a message when the action belongs to another org', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        action_service.update_action_messages_into_db(
          makeReq({ params: { id: 'org-b-action' }, body: { message: 'IDOR attempt' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('creates the message with the authenticated caller as sender, not a client-supplied value', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A, inspectionId: 'insp-1' });
      db.update.mockResolvedValue({});

      await action_service.update_action_messages_into_db(
        makeReq({
          params: { id: 'a1' },
          body: { message: 'Hi there', senderAccountId: 'someone-else' },
        }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.messages.create).toEqual({
        senderAccountId: ORG_A,
        message: 'Hi there',
      });
    });

    it('returns the updated messages list, not just responsibleAssignees', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A, inspectionId: 'insp-1' });
      db.update.mockResolvedValue({
        id: 'a1',
        messages: [{ id: 'msg-1', message: 'Hi there', senderAccountId: ORG_A }],
      });

      const result = await action_service.update_action_messages_into_db(
        makeReq({ params: { id: 'a1' }, body: { message: 'Hi there' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.include).toMatchObject({ messages: expect.anything() });
      expect(result.messages).toEqual([
        { id: 'msg-1', message: 'Hi there', senderAccountId: ORG_A },
      ]);
    });
  });

  // ── attachment upload ────────────────────────────────────────────────────
  describe('upload_action_attachment_into_aws', () => {
    beforeEach(() => {
      mockUploadCloud.mockReset();
    });

    it('uploads the file and returns its URL', async () => {
      mockUploadCloud.mockResolvedValue({ secure_url: 'https://s3/uploaded.jpg', key: 'k1' });

      const result = await action_service.upload_action_attachment_into_aws(
        makeReq({ file: { path: '/tmp/x.jpg' } } as any),
      );

      expect(mockUploadCloud).toHaveBeenCalled();
      expect(result).toEqual({ url: 'https://s3/uploaded.jpg' });
    });

    it('throws 400 when no file is present', async () => {
      await expect(
        action_service.upload_action_attachment_into_aws(makeReq()),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(mockUploadCloud).not.toHaveBeenCalled();
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
        status: 'ACTIVE',
        expiresAt: null,
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
        where: { orgMemberId: MEMBER_ID, revokedAt: null },
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
      assignmentDb.findMany.mockResolvedValue([
        { inspectionId: 'insp-assigned-1', revokedAt: null },
      ]);
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      const [findArg] = db.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ inspectionId: { in: ['insp-assigned-1'] } });
    });

    it('LIGHT_USER with no live FindingAssignment gets nothing back', async () => {
      mockMembership('LIGHT_USER');
      findingAssignmentDb.findMany.mockResolvedValue([]);
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      const [findArg] = db.findMany.mock.calls[0];
      expect(findArg.where.id).toEqual({ in: [] });
      expect(assignmentDb.findMany).not.toHaveBeenCalled();
    });

    it('LIGHT_USER list is restricted by id to their sub-assigned findings (issue #55 slice 4)', async () => {
      mockMembership('LIGHT_USER');
      findingAssignmentDb.findMany.mockResolvedValue([
        { actionId: 'action-assigned-1' },
        { actionId: 'action-assigned-2' },
      ]);
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      expect(findingAssignmentDb.findMany).toHaveBeenCalledWith({
        where: { orgMemberId: MEMBER_ID, status: 'ACTIVE', revokedAt: null },
        select: { actionId: true },
      });
      const [findArg] = db.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({
        orgAccountId: ANCHOR,
        id: { in: ['action-assigned-1', 'action-assigned-2'] },
      });
      // Never scoped by inspectionId for LIGHT_USER — they don't get
      // inspection-level access, only the specific finding(s).
      expect(findArg.where.inspectionId).toBeUndefined();
    });

    it('LIGHT_USER cannot read a finding they are not sub-assigned to', async () => {
      mockMembership('LIGHT_USER');
      findingAssignmentDb.findMany.mockResolvedValue([{ actionId: 'action-assigned-1' }]);
      db.findFirst.mockResolvedValue(null);

      await expect(
        action_service.get_single_action_from_db(makeReq({ params: { id: 'action-other' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      const [findArg] = db.findFirst.mock.calls[0];
      expect(findArg.where.id).toEqual({ in: [] });
    });

    it('LIGHT_USER can update a finding they are actively sub-assigned to', async () => {
      mockMembership('LIGHT_USER');
      findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      db.update.mockResolvedValue({});

      await action_service.update_action_into_db(
        makeReq({ params: { id: 'action-1' }, body: { status: 'COMPLETE' } }),
      );

      expect(db.update).toHaveBeenCalled();
    });

    it('LIGHT_USER cannot smuggle orgAccountId/inspectionId/siteId through update_action_into_db', async () => {
      mockMembership('LIGHT_USER');
      findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      db.update.mockResolvedValue({});

      await action_service.update_action_into_db(
        makeReq({
          params: { id: 'action-1' },
          body: {
            status: 'COMPLETE',
            orgAccountId: 'other-org',
            inspectionId: 'other-inspection',
            siteId: 'other-site',
          },
        }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).toEqual({ status: 'COMPLETE' });
      expect(callArg.data.orgAccountId).toBeUndefined();
      expect(callArg.data.inspectionId).toBeUndefined();
      expect(callArg.data.siteId).toBeUndefined();
    });

    it('LIGHT_USER cannot update a finding they are NOT sub-assigned to', async () => {
      mockMembership('LIGHT_USER');
      findingAssignmentDb.findFirst.mockResolvedValue(null);
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });

      await expect(
        action_service.update_action_into_db(
          makeReq({ params: { id: 'action-1' }, body: { status: 'COMPLETE' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('LIGHT_USER can never delete a finding, even one they are actively sub-assigned to', async () => {
      mockMembership('LIGHT_USER');
      findingAssignmentDb.findMany.mockResolvedValue([{ actionId: 'action-1' }]);
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });

      await expect(
        action_service.delete_action_from_db(makeReq({ params: { id: 'action-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.delete).not.toHaveBeenCalled();
    });

    it('LIGHT_USER can never create a finding, even on an inspection with a live sub-assignment', async () => {
      mockMembership('LIGHT_USER');
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

describe('action service — finding sub-assignment (issue #55 slice 4)', () => {
  const ANCHOR = 'anchor-account-00000000-0000-0000-0000-000000000009';
  const ORG_ID = 'org-00000000-0000-0000-0000-000000000009';
  const MEMBER_ID = 'org-member-00000000-0000-0000-0000-000000000009';
  const LIGHT_USER_MEMBER_ID = 'light-user-member-00000000-0000-0000-000000000010';

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

  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  describe('assign_light_user_to_action', () => {
    it('ADMIN sub-assigns a Light User; status is ACTIVE when approval is not required', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
        .fn()
        .mockResolvedValue({
          id: LIGHT_USER_MEMBER_ID,
          organizationId: ORG_ID,
          role: 'LIGHT_USER',
          status: 'ACTIVE',
          expiresAt: null,
        });
      organizationDb.findUniqueOrThrow = vi
        .fn()
        .mockResolvedValue({ requireApprovalForSubAssignment: false });
      findingAssignmentDb.findFirst.mockResolvedValue(null);
      findingAssignmentDb.create.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        status: 'ACTIVE',
      });

      const result = await action_service.assign_light_user_to_action(
        makeReq({ params: { id: 'action-1' }, body: { orgMemberId: LIGHT_USER_MEMBER_ID } }),
      );

      expect(findingAssignmentDb.create).toHaveBeenCalledWith({
        data: {
          actionId: 'action-1',
          orgMemberId: LIGHT_USER_MEMBER_ID,
          assignedById: ORG_A,
          status: 'ACTIVE',
        },
      });
      expect(result.status).toBe('ACTIVE');
    });

    it('starts PENDING_APPROVAL when the org requires approval for sub-assignment', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
        .fn()
        .mockResolvedValue({
          id: LIGHT_USER_MEMBER_ID,
          organizationId: ORG_ID,
          role: 'LIGHT_USER',
          status: 'ACTIVE',
          expiresAt: null,
        });
      organizationDb.findUniqueOrThrow = vi
        .fn()
        .mockResolvedValue({ requireApprovalForSubAssignment: true });
      findingAssignmentDb.findFirst.mockResolvedValue(null);
      findingAssignmentDb.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'fa-1', ...data }),
      );

      const result = await action_service.assign_light_user_to_action(
        makeReq({ params: { id: 'action-1' }, body: { orgMemberId: LIGHT_USER_MEMBER_ID } }),
      );

      expect(result.status).toBe('PENDING_APPROVAL');
    });

    it('rejects sub-assigning a non-LIGHT_USER member', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
        .fn()
        .mockResolvedValue({ id: 'lead-member-1', organizationId: ORG_ID, role: 'LEAD_AUDITOR' });

      await expect(
        action_service.assign_light_user_to_action(
          makeReq({ params: { id: 'action-1' }, body: { orgMemberId: 'lead-member-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(findingAssignmentDb.create).not.toHaveBeenCalled();
    });

    it('VIEWER cannot sub-assign anyone to a finding', async () => {
      mockMembership('VIEWER');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });

      await expect(
        action_service.assign_light_user_to_action(
          makeReq({ params: { id: 'action-1' }, body: { orgMemberId: LIGHT_USER_MEMBER_ID } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.create).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR not assigned to the parent inspection cannot sub-assign a finding on it', async () => {
      mockMembership('LEAD_AUDITOR');
      assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-other' }]);
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });

      await expect(
        action_service.assign_light_user_to_action(
          makeReq({ params: { id: 'action-1' }, body: { orgMemberId: LIGHT_USER_MEMBER_ID } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.create).not.toHaveBeenCalled();
    });

    it('re-assigning an already-live pair is a no-op that returns the existing row', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
        .fn()
        .mockResolvedValue({
          id: LIGHT_USER_MEMBER_ID,
          organizationId: ORG_ID,
          role: 'LIGHT_USER',
          status: 'ACTIVE',
          expiresAt: null,
        });
      const existing = {
        id: 'fa-existing',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
      };
      findingAssignmentDb.findFirst.mockResolvedValue(existing);

      const result = await action_service.assign_light_user_to_action(
        makeReq({ params: { id: 'action-1' }, body: { orgMemberId: LIGHT_USER_MEMBER_ID } }),
      );

      expect(findingAssignmentDb.create).not.toHaveBeenCalled();
      expect(result).toEqual(existing);
    });

    it('converts a concurrent assign race (partial unique index violation) into the winning row', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
        .fn()
        .mockResolvedValue({
          id: LIGHT_USER_MEMBER_ID,
          organizationId: ORG_ID,
          role: 'LIGHT_USER',
          status: 'ACTIVE',
          expiresAt: null,
        });
      organizationDb.findUniqueOrThrow = vi
        .fn()
        .mockResolvedValue({ requireApprovalForSubAssignment: false });
      const winner = { id: 'fa-winner', actionId: 'action-1', orgMemberId: LIGHT_USER_MEMBER_ID };
      findingAssignmentDb.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      const { Prisma } = await import('@prisma/client');
      findingAssignmentDb.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const result = await action_service.assign_light_user_to_action(
        makeReq({ params: { id: 'action-1' }, body: { orgMemberId: LIGHT_USER_MEMBER_ID } }),
      );

      expect(result).toEqual(winner);
    });

    it('rejects sub-assigning a SUSPENDED Light User member', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
        .fn()
        .mockResolvedValue({
          id: LIGHT_USER_MEMBER_ID,
          organizationId: ORG_ID,
          role: 'LIGHT_USER',
          status: 'SUSPENDED',
          expiresAt: null,
        });

      await expect(
        action_service.assign_light_user_to_action(
          makeReq({ params: { id: 'action-1' }, body: { orgMemberId: LIGHT_USER_MEMBER_ID } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(findingAssignmentDb.create).not.toHaveBeenCalled();
    });

    it('rejects sub-assigning a Light User member whose time-boxed access has expired', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
        .fn()
        .mockResolvedValue({
          id: LIGHT_USER_MEMBER_ID,
          organizationId: ORG_ID,
          role: 'LIGHT_USER',
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() - 1000 * 60 * 60),
        });

      await expect(
        action_service.assign_light_user_to_action(
          makeReq({ params: { id: 'action-1' }, body: { orgMemberId: LIGHT_USER_MEMBER_ID } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(findingAssignmentDb.create).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT sub-assign when the actionId belongs to another org', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue(null);

      await expect(
        action_service.assign_light_user_to_action(
          makeReq({ params: { id: 'org-b-action' }, body: { orgMemberId: LIGHT_USER_MEMBER_ID } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(findingAssignmentDb.create).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT sub-assign when the orgMemberId belongs to another org', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
        .fn()
        .mockResolvedValue(null);

      await expect(
        action_service.assign_light_user_to_action(
          makeReq({ params: { id: 'action-1' }, body: { orgMemberId: 'org-b-member' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(findingAssignmentDb.create).not.toHaveBeenCalled();
    });

    it('a prior REJECTED assignment does not block a fresh sub-assignment for the same (action, member) pair', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
        .fn()
        .mockResolvedValue({
          id: LIGHT_USER_MEMBER_ID,
          organizationId: ORG_ID,
          role: 'LIGHT_USER',
          status: 'ACTIVE',
          expiresAt: null,
        });
      organizationDb.findUniqueOrThrow = vi
        .fn()
        .mockResolvedValue({ requireApprovalForSubAssignment: false });
      // The prior REJECTED row is excluded by the `status: { not: 'REJECTED' } }`
      // clause, so the "existing live" lookup finds nothing and a fresh row
      // is created — verified by asserting findingAssignmentDb.create IS
      // called, not skipped as if the old REJECTED row still counted.
      findingAssignmentDb.findFirst.mockResolvedValue(null);
      findingAssignmentDb.create.mockResolvedValue({
        id: 'fa-2',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        status: 'ACTIVE',
      });

      const result = await action_service.assign_light_user_to_action(
        makeReq({ params: { id: 'action-1' }, body: { orgMemberId: LIGHT_USER_MEMBER_ID } }),
      );

      expect(findingAssignmentDb.findFirst).toHaveBeenCalledWith({
        where: {
          actionId: 'action-1',
          orgMemberId: LIGHT_USER_MEMBER_ID,
          revokedAt: null,
          status: { not: 'REJECTED' },
        },
      });
      expect(findingAssignmentDb.create).toHaveBeenCalled();
      expect(result.id).toBe('fa-2');
    });
  });

  describe('unassign_light_user_from_action', () => {
    it('ADMIN revokes a sub-assignment', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
        .fn()
        .mockResolvedValue({ id: LIGHT_USER_MEMBER_ID, organizationId: ORG_ID });
      findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
      findingAssignmentDb.updateMany.mockResolvedValue({ count: 1 });
      findingAssignmentDb.findUniqueOrThrow.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        revokedAt: new Date(),
        revokedById: ORG_A,
      });

      const result = await action_service.unassign_light_user_from_action(
        makeReq({ params: { id: 'action-1', orgMemberId: LIGHT_USER_MEMBER_ID } }),
      );

      expect(findingAssignmentDb.findFirst).toHaveBeenCalledWith({
        where: {
          actionId: 'action-1',
          orgMemberId: LIGHT_USER_MEMBER_ID,
          revokedAt: null,
          status: { not: 'REJECTED' },
        },
      });
      expect(findingAssignmentDb.updateMany).toHaveBeenCalledWith({
        where: { id: 'fa-1', revokedAt: null },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      });
      expect(result.id).toBe('fa-1');
    });

    it('a concurrent unassign race is a harmless no-op for the loser, not a duplicate audit event', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
        .fn()
        .mockResolvedValue({ id: LIGHT_USER_MEMBER_ID, organizationId: ORG_ID });
      findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
      // Lost the race: a concurrent request already revoked this row
      // between the findFirst read and this updateMany write.
      findingAssignmentDb.updateMany.mockResolvedValue({ count: 0 });
      findingAssignmentDb.findUniqueOrThrow.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        revokedAt: new Date(),
        revokedById: 'someone-else',
      });

      const result = await action_service.unassign_light_user_from_action(
        makeReq({ params: { id: 'action-1', orgMemberId: LIGHT_USER_MEMBER_ID } }),
      );

      expect(result.id).toBe('fa-1');
      expect(prisma.orgAuditLog.create).not.toHaveBeenCalled();
    });

    it('VIEWER cannot revoke a sub-assignment', async () => {
      mockMembership('VIEWER');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });

      await expect(
        action_service.unassign_light_user_from_action(
          makeReq({ params: { id: 'action-1', orgMemberId: LIGHT_USER_MEMBER_ID } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
    });

    it('throws 404 when there is no live assignment to revoke, instead of a silent success', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
        .fn()
        .mockResolvedValue({ id: LIGHT_USER_MEMBER_ID, organizationId: ORG_ID });
      findingAssignmentDb.findFirst.mockResolvedValue(null);

      await expect(
        action_service.unassign_light_user_from_action(
          makeReq({ params: { id: 'action-1', orgMemberId: LIGHT_USER_MEMBER_ID } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 404 and does NOT revoke when the orgMemberId belongs to another org', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
        .fn()
        .mockResolvedValue(null);

      await expect(
        action_service.unassign_light_user_from_action(
          makeReq({ params: { id: 'action-1', orgMemberId: 'org-b-member' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('approve_finding_assignment', () => {
    it('ADMIN approves a PENDING_APPROVAL assignment, making it ACTIVE', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        status: 'PENDING_APPROVAL',
        revokedAt: null,
      });
      findingAssignmentDb.update.mockResolvedValue({
        id: 'fa-1',
        status: 'ACTIVE',
        approvedById: ORG_A,
      });

      const result = await action_service.approve_finding_assignment(
        makeReq({ params: { id: 'fa-1' } }),
      );

      expect(findingAssignmentDb.update).toHaveBeenCalledWith({
        where: { id: 'fa-1' },
        data: { status: 'ACTIVE', approvedById: ORG_A },
      });
      expect(result.status).toBe('ACTIVE');
    });

    it('non-ADMIN cannot approve a finding assignment', async () => {
      mockMembership('LEAD_AUDITOR');

      await expect(
        action_service.approve_finding_assignment(makeReq({ params: { id: 'fa-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.update).not.toHaveBeenCalled();
    });

    it('rejects approving an assignment that is not PENDING_APPROVAL', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        status: 'ACTIVE',
      });

      await expect(
        action_service.approve_finding_assignment(makeReq({ params: { id: 'fa-1' } })),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(findingAssignmentDb.update).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT approve an assignment belonging to another org', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue(null);

      await expect(
        action_service.approve_finding_assignment(makeReq({ params: { id: 'org-b-fa' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(findingAssignmentDb.update).not.toHaveBeenCalled();
    });

    it('LIGHT_USER cannot approve their own pending finding assignment (self-approval)', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        action_service.approve_finding_assignment(
          makeReq({ user: { accountId: ORG_A }, params: { id: 'fa-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.findFirst).not.toHaveBeenCalled();
      expect(findingAssignmentDb.update).not.toHaveBeenCalled();
    });

    it('rejects approving an assignment that was withdrawn (revoked) while still PENDING_APPROVAL', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        status: 'PENDING_APPROVAL',
        revokedAt: new Date(),
      });

      await expect(
        action_service.approve_finding_assignment(makeReq({ params: { id: 'fa-1' } })),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(findingAssignmentDb.update).not.toHaveBeenCalled();
    });
  });

  describe('reject_finding_assignment', () => {
    it('ADMIN rejects a PENDING_APPROVAL assignment', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        status: 'PENDING_APPROVAL',
        revokedAt: null,
      });
      findingAssignmentDb.update.mockResolvedValue({
        id: 'fa-1',
        status: 'REJECTED',
        approvedById: ORG_A,
      });

      const result = await action_service.reject_finding_assignment(
        makeReq({ params: { id: 'fa-1' } }),
      );

      expect(result.status).toBe('REJECTED');
    });

    it('non-ADMIN cannot reject a finding assignment', async () => {
      mockMembership('LEAD_AUDITOR');

      await expect(
        action_service.reject_finding_assignment(makeReq({ params: { id: 'fa-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.update).not.toHaveBeenCalled();
    });

    it('LIGHT_USER cannot reject their own pending finding assignment (self-rejection)', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        action_service.reject_finding_assignment(
          makeReq({ user: { accountId: ORG_A }, params: { id: 'fa-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.findFirst).not.toHaveBeenCalled();
      expect(findingAssignmentDb.update).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT reject an assignment belonging to another org', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue(null);

      await expect(
        action_service.reject_finding_assignment(makeReq({ params: { id: 'org-b-fa' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(findingAssignmentDb.update).not.toHaveBeenCalled();
    });

    it('rejects rejecting an assignment that was already withdrawn (revoked) while still PENDING_APPROVAL', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        status: 'PENDING_APPROVAL',
        revokedAt: new Date(),
      });

      await expect(
        action_service.reject_finding_assignment(makeReq({ params: { id: 'fa-1' } })),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(findingAssignmentDb.update).not.toHaveBeenCalled();
    });

    it('a rejected assignment does not grant the assignee any access (getAssignedActionIds excludes it)', async () => {
      // Documents the invariant directly rather than re-deriving org_scope's
      // own query: getAssignedActionIds filters status: 'ACTIVE', so a
      // REJECTED row is never returned regardless of revokedAt.
      mockMembership('LIGHT_USER');
      findingAssignmentDb.findMany.mockResolvedValue([]);
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      expect(findingAssignmentDb.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE' }) }),
      );
    });
  });

  describe('get_finding_assignments_for_action', () => {
    it('ADMIN can list sub-assignments for a finding', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      findingAssignmentDb.findMany.mockResolvedValue([
        { id: 'fa-1', orgMemberId: LIGHT_USER_MEMBER_ID },
      ]);

      const result = await action_service.get_finding_assignments_for_action(
        makeReq({ params: { id: 'action-1' } }),
      );

      expect(findingAssignmentDb.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { actionId: 'action-1', revokedAt: null } }),
      );
      expect(result).toHaveLength(1);
    });

    it('VIEWER cannot list sub-assignments for a finding', async () => {
      mockMembership('VIEWER');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });

      await expect(
        action_service.get_finding_assignments_for_action(makeReq({ params: { id: 'action-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.findMany).not.toHaveBeenCalled();
    });
  });

  describe('get_my_finding_assignments', () => {
    it('LIGHT_USER sees their own assignments across every status, including pending and rejected', async () => {
      mockMembership('LIGHT_USER');
      const rows = [
        { id: 'fa-1', orgMemberId: MEMBER_ID, status: 'ACTIVE' },
        { id: 'fa-2', orgMemberId: MEMBER_ID, status: 'PENDING_APPROVAL' },
        { id: 'fa-3', orgMemberId: MEMBER_ID, status: 'REJECTED' },
      ];
      findingAssignmentDb.findMany.mockResolvedValue(rows);

      const result = await action_service.get_my_finding_assignments(makeReq());

      expect(findingAssignmentDb.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orgMemberId: MEMBER_ID } }),
      );
      expect(result).toHaveLength(3);
    });

    it("does not leak other members' assignments — only orgMemberId === caller is queried", async () => {
      mockMembership('LIGHT_USER');
      findingAssignmentDb.findMany.mockResolvedValue([]);

      await action_service.get_my_finding_assignments(makeReq());

      const [callArg] = findingAssignmentDb.findMany.mock.calls[0];
      expect(callArg.where).toEqual({ orgMemberId: MEMBER_ID });
    });

    it('returns an empty array for a caller with no OrgMember row (ADMIN-of-self fallback)', async () => {
      orgMemberDb.findUnique.mockResolvedValue(null);

      const result = await action_service.get_my_finding_assignments(makeReq());

      expect(result).toEqual([]);
      expect(findingAssignmentDb.findMany).not.toHaveBeenCalled();
    });
  });
});

describe('action service — external Light User sub-assignment (issue #55 slice 5)', () => {
  const ANCHOR = 'anchor-account-00000000-0000-0000-0000-000000000011';
  const ORG_ID = 'org-00000000-0000-0000-0000-000000000011';
  const MEMBER_ID = 'org-member-00000000-0000-0000-0000-000000000011';
  const EXTERNAL_MEMBER_ID = 'ext-member-00000000-0000-0000-0000-000000000012';

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

  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  describe('assign_light_user_to_action (externalOrgMemberId)', () => {
    it('ADMIN sub-assigns an external Light User; status is ACTIVE when approval is not required', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      externalOrgMemberDb.findFirst.mockResolvedValue({
        id: EXTERNAL_MEMBER_ID,
        organizationId: ORG_ID,
        role: 'LIGHT_USER',
        isActive: true,
        expiresAt: null,
      });
      organizationDb.findUniqueOrThrow = vi
        .fn()
        .mockResolvedValue({ requireApprovalForSubAssignment: false });
      findingAssignmentDb.findFirst.mockResolvedValue(null);
      findingAssignmentDb.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'fa-1', ...data }),
      );

      const result = await action_service.assign_light_user_to_action(
        makeReq({ params: { id: 'action-1' }, body: { externalOrgMemberId: EXTERNAL_MEMBER_ID } }),
      );

      expect(findingAssignmentDb.create).toHaveBeenCalledWith({
        data: {
          actionId: 'action-1',
          externalOrgMemberId: EXTERNAL_MEMBER_ID,
          assignedById: ORG_A,
          status: 'ACTIVE',
        },
      });
      expect(result.status).toBe('ACTIVE');
    });

    it('rejects sub-assigning an external member who is not LIGHT_USER role', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      externalOrgMemberDb.findFirst.mockResolvedValue({
        id: EXTERNAL_MEMBER_ID,
        organizationId: ORG_ID,
        role: 'VIEWER',
        isActive: true,
        expiresAt: null,
      });

      await expect(
        action_service.assign_light_user_to_action(
          makeReq({
            params: { id: 'action-1' },
            body: { externalOrgMemberId: EXTERNAL_MEMBER_ID },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(findingAssignmentDb.create).not.toHaveBeenCalled();
    });

    it('rejects sub-assigning a deactivated external member', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      externalOrgMemberDb.findFirst.mockResolvedValue({
        id: EXTERNAL_MEMBER_ID,
        organizationId: ORG_ID,
        role: 'LIGHT_USER',
        isActive: false,
        expiresAt: null,
      });

      await expect(
        action_service.assign_light_user_to_action(
          makeReq({
            params: { id: 'action-1' },
            body: { externalOrgMemberId: EXTERNAL_MEMBER_ID },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(findingAssignmentDb.create).not.toHaveBeenCalled();
    });

    it('throws 404 when the external member does not belong to the caller org', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      externalOrgMemberDb.findFirst.mockResolvedValue(null);

      await expect(
        action_service.assign_light_user_to_action(
          makeReq({ params: { id: 'action-1' }, body: { externalOrgMemberId: 'org-b-ext' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('records the audit event with subjectExternalOrgMemberId, not subjectOrgMemberId', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      externalOrgMemberDb.findFirst.mockResolvedValue({
        id: EXTERNAL_MEMBER_ID,
        organizationId: ORG_ID,
        role: 'LIGHT_USER',
        isActive: true,
        expiresAt: null,
      });
      organizationDb.findUniqueOrThrow = vi
        .fn()
        .mockResolvedValue({ requireApprovalForSubAssignment: false });
      findingAssignmentDb.findFirst.mockResolvedValue(null);
      findingAssignmentDb.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'fa-1', ...data }),
      );

      await action_service.assign_light_user_to_action(
        makeReq({ params: { id: 'action-1' }, body: { externalOrgMemberId: EXTERNAL_MEMBER_ID } }),
      );

      const [auditArg] = (prisma.orgAuditLog.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(auditArg.data.subjectExternalOrgMemberId).toBe(EXTERNAL_MEMBER_ID);
      expect(auditArg.data.subjectOrgMemberId).toBeNull();
    });
  });

  describe('unassign_external_light_user_from_action', () => {
    it('revokes a live external sub-assignment', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      externalOrgMemberDb.findFirst.mockResolvedValue({
        id: EXTERNAL_MEMBER_ID,
        organizationId: ORG_ID,
      });
      findingAssignmentDb.findFirst.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        externalOrgMemberId: EXTERNAL_MEMBER_ID,
        status: 'ACTIVE',
        revokedAt: null,
      });
      findingAssignmentDb.updateMany.mockResolvedValue({ count: 1 });
      findingAssignmentDb.findUniqueOrThrow.mockResolvedValue({
        id: 'fa-1',
        revokedAt: new Date(),
      });

      const result = await action_service.unassign_external_light_user_from_action(
        makeReq({ params: { id: 'action-1', externalOrgMemberId: EXTERNAL_MEMBER_ID } }),
      );

      expect(findingAssignmentDb.updateMany).toHaveBeenCalledWith({
        where: { id: 'fa-1', revokedAt: null },
        data: expect.objectContaining({ revokedById: ORG_A }),
      });
      expect(result.revokedAt).not.toBeNull();
    });

    it('throws 404 when no live assignment exists for this external member', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({
        id: 'action-1',
        inspectionId: 'insp-1',
        orgAccountId: ANCHOR,
      });
      externalOrgMemberDb.findFirst.mockResolvedValue({
        id: EXTERNAL_MEMBER_ID,
        organizationId: ORG_ID,
      });
      findingAssignmentDb.findFirst.mockResolvedValue(null);

      await expect(
        action_service.unassign_external_light_user_from_action(
          makeReq({ params: { id: 'action-1', externalOrgMemberId: EXTERNAL_MEMBER_ID } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('get_my_finding_assignments_external', () => {
    it("queries only the caller's own externalOrgMemberId", async () => {
      findingAssignmentDb.findMany.mockResolvedValue([]);

      await action_service.get_my_finding_assignments_external(
        makeReq({ externalMember: { externalOrgMemberId: EXTERNAL_MEMBER_ID } } as never),
      );

      const [callArg] = findingAssignmentDb.findMany.mock.calls[0];
      expect(callArg.where).toEqual({ externalOrgMemberId: EXTERNAL_MEMBER_ID });
    });
  });

  describe('get_single_action_for_external_member', () => {
    it('returns the action when the external member holds a live assignment for it', async () => {
      findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
      db.findFirst.mockResolvedValue({ id: 'action-1', orgAccountId: ANCHOR });

      const result = await action_service.get_single_action_for_external_member(
        makeReq({
          params: { id: 'action-1' },
          externalMember: { externalOrgMemberId: EXTERNAL_MEMBER_ID, organizationId: ANCHOR },
        } as never),
      );

      expect(result).toMatchObject({ id: 'action-1' });
    });

    it('throws 404 when the external member has no assignment for this action', async () => {
      findingAssignmentDb.findFirst.mockResolvedValue(null);

      await expect(
        action_service.get_single_action_for_external_member(
          makeReq({
            params: { id: 'action-1' },
            externalMember: { externalOrgMemberId: EXTERNAL_MEMBER_ID, organizationId: ANCHOR },
          } as never),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('update_action_for_external_member', () => {
    it('updates the action when a live FindingAssignment exists', async () => {
      db.findFirst.mockResolvedValue({ id: 'action-1', orgAccountId: ANCHOR });
      findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
      db.update.mockResolvedValue({ id: 'action-1', status: 'IN_PROGRESS' });

      const result = await action_service.update_action_for_external_member(
        makeReq({
          params: { id: 'action-1' },
          body: { status: 'IN_PROGRESS' },
          externalMember: { externalOrgMemberId: EXTERNAL_MEMBER_ID, organizationId: ANCHOR },
        } as never),
      );

      expect(result.status).toBe('IN_PROGRESS');
    });

    it('throws 403 when no live FindingAssignment exists for this action', async () => {
      db.findFirst.mockResolvedValue({ id: 'action-1', orgAccountId: ANCHOR });
      findingAssignmentDb.findFirst.mockResolvedValue(null);

      await expect(
        action_service.update_action_for_external_member(
          makeReq({
            params: { id: 'action-1' },
            body: { status: 'IN_PROGRESS' },
            externalMember: { externalOrgMemberId: EXTERNAL_MEMBER_ID, organizationId: ANCHOR },
          } as never),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('throws 404 for another org action', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        action_service.update_action_for_external_member(
          makeReq({
            params: { id: 'org-b-action' },
            body: { status: 'IN_PROGRESS' },
            externalMember: { externalOrgMemberId: EXTERNAL_MEMBER_ID, organizationId: ANCHOR },
          } as never),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });
  });
});
