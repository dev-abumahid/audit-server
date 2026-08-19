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
    complianceObligation: {
      findFirst: vi.fn(),
    },
    // aexa-server#244: formal engagement<->finding link, ownership-checked
    // the same way as complianceObligationId above.
    auditEngagement: {
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
    // aexa-server#252: finding closure maker-checker workflow.
    actionClosureApproval: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    actionLineReview: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    orgAuditLog: {
      create: vi.fn(),
    },
    externalOrgMember: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    // aexa-server#252: update_action_into_db now wraps the finding update
    // and the closure-invalidation-on-edit hook in a $transaction, same
    // pattern as risk.service.ts's #203 precedent. The mock runs the
    // interactive callback with the same mocked prisma as the tx client.
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { action_service } from '../../app/modules/action/action.service.js';
import uploadCloud from '../../app/utils/cloudinary.js';

const mockUploadCloud = vi.mocked(uploadCloud);

const db = prisma.action as unknown as Record<string, ReturnType<typeof vi.fn>>;
const dbInspection = prisma.inspection as unknown as Record<string, ReturnType<typeof vi.fn>>;
const dbQuestion = prisma.question as unknown as Record<string, ReturnType<typeof vi.fn>>;
const dbCompliance = prisma.complianceObligation as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const dbAuditEngagement = prisma.auditEngagement as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const closureDb = prisma.actionClosureApproval as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const actionLineReviewDb = prisma.actionLineReview as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const txFn = (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction;
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
    // aexa-server#252: update_action_into_db wraps the update + closure-
    // invalidation-on-edit hook in a $transaction; default to no live
    // closure cycle (the common case) unless a test overrides it.
    txFn.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
    closureDb.findMany.mockResolvedValue([]);
    // Default (#97): invalidateLiveLineReviews's updateMany is a no-op call
    // on every edit unless a specific test asserts on it.
    actionLineReviewDb.updateMany.mockResolvedValue({ count: 0 });
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

    it('includes auditEngagementId in the WHERE clause when provided', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(
        makeReq({ query: { auditEngagementId: 'eng-1' } }),
      );

      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgAccountId: ORG_A, auditEngagementId: 'eng-1' },
        }),
      );
    });

    it('does not filter by auditEngagementId when not provided', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      const callArg = db.findMany.mock.calls[0][0];
      expect(callArg.where).not.toHaveProperty('auditEngagementId');
    });

    // quality-bar-loop round (Audit Missions efficiency/resilience): the
    // frontend's batched remediation-status fetch (aexa-frontend#902) now
    // sends every visible completed engagement's id as one comma-separated
    // auditEngagementId value instead of firing one request per engagement.
    it('wraps a comma-separated auditEngagementId list in a Prisma "in" clause', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(
        makeReq({ query: { auditEngagementId: 'eng-1,eng-2,eng-3' } }),
      );

      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgAccountId: ORG_A, auditEngagementId: { in: ['eng-1', 'eng-2', 'eng-3'] } },
        }),
      );
    });

    // The single-id path must stay a plain string match (not wrapped in
    // `{in: [...]}`) since every other caller of this endpoint still passes
    // exactly one id -- covered by the plain 'includes auditEngagementId in
    // the WHERE clause when provided' test above, asserted again here
    // explicitly against a single-element comma-free value for clarity.
    it('does not wrap a single auditEngagementId in an "in" clause', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(
        makeReq({ query: { auditEngagementId: 'eng-1' } }),
      );

      const callArg = db.findMany.mock.calls[0][0];
      expect(callArg.where.auditEngagementId).toBe('eng-1');
    });

    // Review-round regression coverage: a trailing/leading comma used to
    // fall back to the raw, unfiltered auditEngagementId string (e.g.
    // "eng-1,") instead of the single parsed id, silently matching zero
    // rows in the DB instead of the intended engagement.
    it('resolves to the single parsed id, not the raw string, when the list has a trailing comma', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(
        makeReq({ query: { auditEngagementId: 'eng-1,' } }),
      );

      const callArg = db.findMany.mock.calls[0][0];
      expect(callArg.where.auditEngagementId).toBe('eng-1');
    });

    it('trims whitespace around each id in a comma-separated list', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(
        makeReq({ query: { auditEngagementId: 'eng-1, eng-2 ' } }),
      );

      expect(db.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgAccountId: ORG_A, auditEngagementId: { in: ['eng-1', 'eng-2'] } },
        }),
      );
    });

    // Review-round regression coverage: an all-comma/whitespace input left
    // `ids` empty, so the where clause fell back to `ids[0]` (`undefined`)
    // -- Prisma treats an undefined field value as "no filter", not "match
    // nothing", so this silently returned every action in the org instead
    // of failing closed like every other non-matching value does.
    it('fails closed (matches nothing) instead of dropping the filter when every id is empty after trimming', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(
        makeReq({ query: { auditEngagementId: ',, ,' } }),
      );

      const callArg = db.findMany.mock.calls[0][0];
      // Pinned to the exact value, not just "not undefined" -- a still-broken
      // variant that set this to `null` instead would pass a looser check
      // but be worse than the original bug: for a nullable column, `null`
      // means Prisma matches "IS NULL", leaking every action with no
      // engagement at all instead of genuinely matching zero rows.
      expect(callArg.where.auditEngagementId).toBe('');
    });

    // Issue #162 (follow-up to #126): the list endpoint used to spread the
    // full MESSAGES_INCLUDE (message bodies + sender account/profile) on
    // every row just so aexa-frontend's list badge could show a count.
    // aexa-frontend's edit-from-list flow now fetches GET /action/:id for
    // full message bodies instead (Qiyrix/aexa-frontend#119), so the list
    // include only needs enough to support `action.messages?.length`.
    it('includes only message ids (not full MESSAGES_INCLUDE) on the list endpoint', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await action_service.get_all_action_from_db(makeReq());

      const callArg = db.findMany.mock.calls[0][0];
      expect(callArg.include.messages).toEqual({ select: { id: true } });
    });

    it('still returns enough for the list badge to count messages accurately', async () => {
      const orgARecord = {
        id: 'a1',
        orgAccountId: ORG_A,
        messages: [{ id: 'm1' }, { id: 'm2' }],
      };
      db.findMany.mockResolvedValue([orgARecord]);
      db.count.mockResolvedValue(1);

      const result = await action_service.get_all_action_from_db(makeReq());

      expect(result.data[0].messages).toHaveLength(2);
    });

    // Issue #125: this endpoint hand-rolled `Number(req.query.page) || 1`
    // pagination instead of the shared paginationHelper/buildPaginationMeta,
    // so it never picked up the MAX_LIMIT cap and computed totalPage inline.
    it('includes totalPage in meta, computed via the shared pagination helper', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(23);

      const result = await action_service.get_all_action_from_db(
        makeReq({ query: { page: '2', limit: '10' } }),
      );

      expect(result.meta).toEqual({
        page: 2,
        limit: 10,
        skip: 10,
        total: 23,
        totalPage: 3,
      });
    });

    it('caps an oversized requested limit at MAX_LIMIT (100) instead of fetching unbounded rows', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      const result = await action_service.get_all_action_from_db(
        makeReq({ query: { page: '1', limit: '1000000' } }),
      );

      expect(result.meta.limit).toBe(100);
      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.take).toBe(100);
    });

    it('defaults to page 1 / limit 10 when no query params are supplied', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      const result = await action_service.get_all_action_from_db(makeReq());

      expect(result.meta).toEqual({
        page: 1,
        limit: 10,
        skip: 0,
        total: 0,
        totalPage: 0,
      });
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

    // aexa-server#252: a finding can't be born already closed — that would
    // bypass the closure verification workflow entirely.
    describe('closure verification (#252)', () => {
      it.each(['COMPLETE', 'CANT_DO'])(
        'rejects creating a finding with status: %s',
        async (status) => {
          await expect(
            action_service.create_action_into_db(
              makeReq({ body: { inspectionId: 'insp-1', title: 'x', status } }),
            ),
          ).rejects.toMatchObject({ statusCode: 400 });

          expect(dbInspection.findFirst).not.toHaveBeenCalled();
          expect(db.create).not.toHaveBeenCalled();
        },
      );

      it('allows creating a finding with status: TO_DO or IN_PROGRESS', async () => {
        dbInspection.findFirst.mockResolvedValue({
          id: 'insp-1',
          siteId: 'site-1',
          orgAccountId: ORG_A,
        });
        db.create.mockResolvedValue({});

        await action_service.create_action_into_db(
          makeReq({ body: { inspectionId: 'insp-1', title: 'x', status: 'IN_PROGRESS' } }),
        );

        expect(db.create).toHaveBeenCalled();
      });
    });

    // aexa-server#311: message visibility on create.
    describe('message visibility (#311)', () => {
      it('omits visibility (letting the Prisma column default of INTERNAL apply) when not specified', async () => {
        dbInspection.findFirst.mockResolvedValue({
          id: 'insp-1',
          siteId: 'site-1',
          orgAccountId: ORG_A,
        });
        db.create.mockResolvedValue({ id: 'new', orgAccountId: ORG_A });

        await action_service.create_action_into_db(
          makeReq({
            body: {
              inspectionId: 'insp-1',
              actionTitle: 'x',
              messages: [{ message: 'hello' }],
            },
          }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data.messages.create[0]).toEqual({
          senderAccountId: ORG_A,
          message: 'hello',
        });
        expect(callArg.data.messages.create[0]).not.toHaveProperty('visibility');
      });

      it('threads an explicit visibility through when the caller provides one', async () => {
        dbInspection.findFirst.mockResolvedValue({
          id: 'insp-1',
          siteId: 'site-1',
          orgAccountId: ORG_A,
        });
        db.create.mockResolvedValue({ id: 'new', orgAccountId: ORG_A });

        await action_service.create_action_into_db(
          makeReq({
            body: {
              inspectionId: 'insp-1',
              actionTitle: 'x',
              messages: [{ message: 'hello', visibility: 'CLIENT_VISIBLE' }],
            },
          }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data.messages.create[0]).toEqual({
          senderAccountId: ORG_A,
          message: 'hello',
          visibility: 'CLIENT_VISIBLE',
        });
      });
    });

    // Issue #97: no extra role gate needed on create — assertCanWriteToInspection
    // already restricts action creation to ADMIN/LEAD_AUDITOR, the same set
    // allowed to reassign line_of_defense on update. This just confirms the
    // field is actually written through, matching action.validation.ts's
    // create_action schema requiring it (though the service itself doesn't
    // re-validate — that happens at the route/RequestValidator layer).
    it('persists line_of_defense supplied on create', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      db.create.mockResolvedValue({ id: 'new', orgAccountId: ORG_A, line_of_defense: 'SECOND' });

      await action_service.create_action_into_db(
        makeReq({
          body: { inspectionId: 'insp-1', actionTitle: 'Mitigate risk', line_of_defense: 'SECOND' },
        }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.line_of_defense).toBe('SECOND');
    });

    // #191 review: the migration adding ai_generated/is_edited to Action was
    // verified correct by reading its SQL (NOT NULL DEFAULT false), but
    // nothing asserted that a REGULAR action creation (the normal POST
    // /action path, as opposed to #191's create-action-from-bucket) actually
    // relies on that DB default rather than the service accidentally setting
    // one of these fields itself. Confirms create_action_into_db's data
    // object never includes either key for an ordinary creation -- the
    // schema default is what applies, this service path makes no claim
    // about AI provenance at all.
    it('does not set ai_generated/is_edited on a regular action creation, leaving the DB default to apply', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      db.create.mockResolvedValue({ id: 'new', orgAccountId: ORG_A });

      await action_service.create_action_into_db(
        makeReq({ body: { inspectionId: 'insp-1', actionTitle: 'Mitigate risk' } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data).not.toHaveProperty('ai_generated');
      expect(callArg.data).not.toHaveProperty('is_edited');
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

    it('allows creating an action with no complianceObligationId at all (it is optional)', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      db.create.mockResolvedValue({});

      await action_service.create_action_into_db(
        makeReq({ body: { inspectionId: 'insp-1', title: 'No obligation' } }),
      );

      expect(dbCompliance.findFirst).not.toHaveBeenCalled();
      expect(db.create).toHaveBeenCalled();
    });

    it('verifies complianceObligationId belongs to the caller org and persists the link (aexa-frontend#166)', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      dbCompliance.findFirst.mockResolvedValue({ id: 'obl-1' });
      db.create.mockResolvedValue({});

      await action_service.create_action_into_db(
        makeReq({
          body: {
            inspectionId: 'insp-1',
            title: 'Remediate: GDPR',
            complianceObligationId: 'obl-1',
          },
        }),
      );

      // Ownership check is org-scoped by the anchor account id (org_account_id).
      expect(dbCompliance.findFirst).toHaveBeenCalledWith({
        where: { id: 'obl-1', org_account_id: ORG_A },
      });
      // The real relation is written onto the created row, not just a text ref.
      expect(db.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ complianceObligationId: 'obl-1' }),
        }),
      );
    });

    it('throws 404 and does NOT create when complianceObligationId belongs to another org (aexa-frontend#166)', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      dbCompliance.findFirst.mockResolvedValue(null); // org-B obligation not found for org-A

      await expect(
        action_service.create_action_into_db(
          makeReq({
            body: {
              inspectionId: 'insp-1',
              title: 'IDOR attempt',
              complianceObligationId: 'org-b-obligation',
            },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.create).not.toHaveBeenCalled();
    });

    // aexa-server#244: formal engagement<->finding link, same IDOR-guard
    // shape as complianceObligationId above.
    it('allows creating an action with no auditEngagementId at all (it is optional)', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      db.create.mockResolvedValue({});

      await action_service.create_action_into_db(
        makeReq({ body: { inspectionId: 'insp-1', title: 'No engagement' } }),
      );

      expect(dbAuditEngagement.findFirst).not.toHaveBeenCalled();
      expect(db.create).toHaveBeenCalled();
    });

    it('verifies auditEngagementId belongs to the caller org and persists the link', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      dbAuditEngagement.findFirst.mockResolvedValue({ id: 'eng-1' });
      db.create.mockResolvedValue({});

      await action_service.create_action_into_db(
        makeReq({
          body: {
            inspectionId: 'insp-1',
            title: 'Finding for Q3 audit',
            auditEngagementId: 'eng-1',
          },
        }),
      );

      expect(dbAuditEngagement.findFirst).toHaveBeenCalledWith({
        where: { id: 'eng-1', org_account_id: ORG_A },
      });
      expect(db.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ auditEngagementId: 'eng-1' }) }),
      );
    });

    it('throws 404 and does NOT create when auditEngagementId belongs to another org', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      dbAuditEngagement.findFirst.mockResolvedValue(null);

      await expect(
        action_service.create_action_into_db(
          makeReq({
            body: {
              inspectionId: 'insp-1',
              title: 'IDOR attempt',
              auditEngagementId: 'org-b-engagement',
            },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.create).not.toHaveBeenCalled();
    });

    // aexa-server#244: IIA's Five Cs — persisted on create when supplied,
    // all genuinely optional (no 400 when omitted).
    it('persists criteria/condition/cause/effect when provided', async () => {
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
            title: 'Access review not performed',
            criteria: 'SOX ITGC access review policy, section 4.2',
            condition: 'No quarterly access review was performed for Q2',
            cause: 'Review owner left the org and the task was never reassigned',
            effect: 'Unauthorized access could go undetected for a full quarter',
          },
        }),
      );

      expect(db.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            criteria: 'SOX ITGC access review policy, section 4.2',
            condition: 'No quarterly access review was performed for Q2',
            cause: 'Review owner left the org and the task was never reassigned',
            effect: 'Unauthorized access could go undetected for a full quarter',
          }),
        }),
      );
    });

    it('allows creating an action with none of the Five Cs fields (all optional)', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      db.create.mockResolvedValue({});

      await action_service.create_action_into_db(
        makeReq({ body: { inspectionId: 'insp-1', title: 'Plain remediation task' } }),
      );

      expect(db.create).toHaveBeenCalled();
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

    it('creates an action with actionDisc omitted -- aexa-frontend sends undefined for a blank "Description (Optional)" field, and Action.actionDisc is now a nullable column', async () => {
      dbInspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        siteId: 'site-1',
        orgAccountId: ORG_A,
      });
      db.create.mockResolvedValue({ id: 'new', orgAccountId: ORG_A });

      await action_service.create_action_into_db(
        makeReq({ body: { inspectionId: 'insp-1', actionTitle: 'No description' } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.actionDisc).toBeUndefined();
      expect(db.create).toHaveBeenCalled();
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

    // aexa-server#252: COMPLETE/CANT_DO are only ever reached via an
    // APPROVED closure cycle, never a direct PATCH.
    describe('closure verification (#252)', () => {
      it.each(['COMPLETE', 'CANT_DO'])(
        'rejects a direct PATCH setting status: %s',
        async (status) => {
          db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });

          await expect(
            action_service.update_action_into_db(
              makeReq({ params: { id: 'a1' }, body: { status } }),
            ),
          ).rejects.toMatchObject({ statusCode: 400 });

          expect(db.update).not.toHaveBeenCalled();
        },
      );

      it('allows a direct PATCH setting status: TO_DO or IN_PROGRESS', async () => {
        db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
        db.update.mockResolvedValue({});

        await action_service.update_action_into_db(
          makeReq({ params: { id: 'a1' }, body: { status: 'IN_PROGRESS' } }),
        );

        expect(db.update).toHaveBeenCalled();
      });

      // invalidateLiveClosureApprovalsOnEdit resolves the real Organization.id
      // via requireCallerOrganizationId, which needs a real OrgMember row (the
      // default ADMIN-of-self fallback has no Organization to resolve) — same
      // requirement risk.approval.service.ts's equivalent hook has.
      const REAL_ORG_ID = 'real-org-00000000-0000-0000-0000-000000000252';
      const mockRealOrgMembership = () => {
        orgMemberDb.findUnique.mockResolvedValue({
          id: 'caller-member-00000000-0000-0000-0000-000000000252',
          organizationId: REAL_ORG_ID,
          accountId: ORG_A,
          role: 'ADMIN',
          status: 'ACTIVE',
          expiresAt: null,
        });
        organizationDb.findUnique.mockResolvedValue({ id: REAL_ORG_ID, anchorAccountId: ORG_A });
      };

      it('invalidates a live closure cycle when the finding is edited', async () => {
        mockRealOrgMembership();
        db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
        db.update.mockResolvedValue({ id: 'a1' });
        closureDb.findMany.mockResolvedValue([{ id: 'ca-1', status: 'PENDING_APPROVAL' }]);
        closureDb.updateMany.mockResolvedValue({ count: 1 });

        await action_service.update_action_into_db(
          makeReq({ params: { id: 'a1' }, body: { title: 'Revised' } }),
        );

        expect(closureDb.updateMany).toHaveBeenCalledWith({
          where: {
            actionId: 'a1',
            invalidatedAt: null,
            status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
          },
          data: { invalidatedAt: expect.any(Date), invalidatedById: ORG_A },
        });
        // Only ever one Action.update call here: the field edit itself. A
        // merely-pending cycle never advanced Action.status, so invalidating
        // it must not trigger a second, status-reverting update.
        expect(db.update).toHaveBeenCalledTimes(1);
      });

      // aexa-server#258: editing a finding's content (e.g. swapping out
      // attachments) after its closure was already APPROVED must invalidate
      // that sign-off AND revert Action.status away from the terminal value
      // it set — otherwise the finding keeps reading COMPLETE/CANT_DO with a
      // certified sign-off on record against content nobody re-reviewed.
      it('aexa-server#258: editing a finding with a live APPROVED closure invalidates it and reverts Action.status to IN_PROGRESS', async () => {
        mockRealOrgMembership();
        db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A, status: 'COMPLETE' });
        db.update.mockResolvedValue({ id: 'a1' });
        closureDb.findMany.mockResolvedValue([{ id: 'ca-1', status: 'APPROVED' }]);
        closureDb.updateMany.mockResolvedValue({ count: 1 });

        await action_service.update_action_into_db(
          makeReq({ params: { id: 'a1' }, body: { attachments: [] } }),
        );

        expect(closureDb.updateMany).toHaveBeenCalledWith({
          where: {
            actionId: 'a1',
            invalidatedAt: null,
            status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
          },
          data: { invalidatedAt: expect.any(Date), invalidatedById: ORG_A },
        });
        // Two Action.update calls: the field edit itself, then the
        // status-reverting one from invalidateLiveClosureApprovalsOnEdit.
        expect(db.update).toHaveBeenCalledTimes(2);
        expect(db.update).toHaveBeenNthCalledWith(2, {
          where: { id: 'a1' },
          data: { status: 'IN_PROGRESS' },
        });
      });

      // aexa-server#258 review round 1: the first version of this fix forced
      // Action.status to IN_PROGRESS unconditionally whenever a live APPROVED
      // cycle existed, even if the SAME PATCH already set status explicitly
      // (e.g. an admin reverting a COMPLETE finding straight to TO_DO) --
      // silently clobbering that explicit choice with IN_PROGRESS. The
      // caller's own explicit status must win.
      it('aexa-server#258 review: does not override an explicit status in the same PATCH that invalidates a live APPROVED closure', async () => {
        mockRealOrgMembership();
        db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A, status: 'COMPLETE' });
        db.update.mockResolvedValue({ id: 'a1' });
        closureDb.findMany.mockResolvedValue([{ id: 'ca-1', status: 'APPROVED' }]);
        closureDb.updateMany.mockResolvedValue({ count: 1 });

        await action_service.update_action_into_db(
          makeReq({ params: { id: 'a1' }, body: { status: 'TO_DO' } }),
        );

        // Only ONE Action.update call: the field edit that sets status:
        // 'TO_DO' directly. No second call forcing it to IN_PROGRESS.
        expect(db.update).toHaveBeenCalledTimes(1);
        expect(db.update).toHaveBeenCalledWith({
          where: { id: 'a1' },
          data: { status: 'TO_DO' },
          include: expect.anything(),
        });
      });

      it('does NOT touch closure cycles when the edited finding has none live', async () => {
        db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
        db.update.mockResolvedValue({ id: 'a1' });
        closureDb.findMany.mockResolvedValue([]);

        await action_service.update_action_into_db(
          makeReq({ params: { id: 'a1' }, body: { title: 'Revised' } }),
        );

        expect(closureDb.updateMany).not.toHaveBeenCalled();
      });

      it('wraps the finding update and the closure invalidation in a single $transaction', async () => {
        mockRealOrgMembership();
        db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
        db.update.mockResolvedValue({ id: 'a1' });
        closureDb.findMany.mockResolvedValue([{ id: 'ca-1' }]);
        closureDb.updateMany.mockResolvedValue({ count: 1 });

        await action_service.update_action_into_db(
          makeReq({ params: { id: 'a1' }, body: { title: 'Revised' } }),
        );

        expect(txFn).toHaveBeenCalledTimes(1);
        expect(db.update).toHaveBeenCalled();
        expect(closureDb.updateMany).toHaveBeenCalled();
      });
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

    // aexa-server#244: IIA's Five Cs ARE writable on update.
    it('updates criteria/condition/cause/effect when provided', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      db.update.mockResolvedValue({});

      await action_service.update_action_into_db(
        makeReq({
          params: { id: 'a1' },
          body: {
            criteria: 'Updated criteria',
            condition: 'Updated condition',
            cause: 'Updated cause',
            effect: 'Updated effect',
          },
        }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).toMatchObject({
        criteria: 'Updated criteria',
        condition: 'Updated condition',
        cause: 'Updated cause',
        effect: 'Updated effect',
      });
    });

    it('leaves criteria/condition/cause/effect untouched when not provided', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      db.update.mockResolvedValue({});

      await action_service.update_action_into_db(
        makeReq({ params: { id: 'a1' }, body: { actionTitle: 'Renamed' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).not.toHaveProperty('criteria');
      expect(callArg.data).not.toHaveProperty('condition');
      expect(callArg.data).not.toHaveProperty('cause');
      expect(callArg.data).not.toHaveProperty('effect');
    });

    // aexa-server#244: unlike the Five Cs, auditEngagementId is set-once at
    // creation only — same as complianceObligationId's existing precedent
    // (not re-checked/re-pointable via a later PATCH).
    it('ignores an auditEngagementId supplied on update — not part of the writable field set', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      db.update.mockResolvedValue({});

      await action_service.update_action_into_db(
        makeReq({ params: { id: 'a1' }, body: { auditEngagementId: 'org-b-or-any-engagement' } }),
      );

      expect(dbAuditEngagement.findFirst).not.toHaveBeenCalled();
      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).not.toHaveProperty('auditEngagementId');
    });

    it('leaves actionDisc untouched when not provided on update (matches attachments/other optional-field convention)', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A });
      db.update.mockResolvedValue({});

      await action_service.update_action_into_db(
        makeReq({ params: { id: 'a1' }, body: { actionTitle: 'Renamed' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).not.toHaveProperty('actionDisc');
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

    // aexa-server#311: message visibility on this creation path too.
    it('omits visibility (letting the Prisma column default of INTERNAL apply) when not specified', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A, inspectionId: 'insp-1' });
      db.update.mockResolvedValue({});

      await action_service.update_action_messages_into_db(
        makeReq({ params: { id: 'a1' }, body: { message: 'Hi there' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.messages.create).toEqual({
        senderAccountId: ORG_A,
        message: 'Hi there',
      });
      expect(callArg.data.messages.create).not.toHaveProperty('visibility');
    });

    it('threads an explicit visibility through when the caller provides one', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ORG_A, inspectionId: 'insp-1' });
      db.update.mockResolvedValue({});

      await action_service.update_action_messages_into_db(
        makeReq({
          params: { id: 'a1' },
          body: { message: 'Hi there', visibility: 'CLIENT_VISIBLE' },
        }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.messages.create).toEqual({
        senderAccountId: ORG_A,
        message: 'Hi there',
        visibility: 'CLIENT_VISIBLE',
      });
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
        makeReq({ params: { id: 'action-1' }, body: { status: 'IN_PROGRESS' } }),
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
            status: 'IN_PROGRESS',
            orgAccountId: 'other-org',
            inspectionId: 'other-inspection',
            siteId: 'other-site',
          },
        }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).toEqual({ status: 'IN_PROGRESS' });
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

    // Issue #97: Three Lines of Defense classification. update_action_into_db
    // is gated by assertCanWriteToAction, which is DELIBERATELY BROADER than
    // assertCanWriteOrgResource — it also lets a sub-assigned LIGHT_USER
    // update a finding's other fields (status, attachments, ...). Reassigning
    // line_of_defense must stay restricted to ADMIN/LEAD_AUDITOR, so these
    // tests confirm the extra assertCanWriteOrgResource check inside
    // update_action_into_db actually fires for that one field, without
    // blocking the LIGHT_USER's normal (non-reassignment) update.
    describe('write-path scoping — line_of_defense (#97)', () => {
      it('LIGHT_USER sub-assigned to the finding CAN update it, but CANNOT include line_of_defense', async () => {
        mockMembership('LIGHT_USER');
        findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
        db.findFirst.mockResolvedValue({
          id: 'action-1',
          inspectionId: 'insp-1',
          orgAccountId: ANCHOR,
        });

        await expect(
          action_service.update_action_into_db(
            makeReq({
              params: { id: 'action-1' },
              body: { status: 'COMPLETE', line_of_defense: 'SECOND' },
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(db.update).not.toHaveBeenCalled();
      });

      it('LIGHT_USER sub-assigned to the finding can still update other fields when line_of_defense is omitted', async () => {
        mockMembership('LIGHT_USER');
        findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
        db.findFirst.mockResolvedValue({
          id: 'action-1',
          inspectionId: 'insp-1',
          orgAccountId: ANCHOR,
        });
        db.update.mockResolvedValue({});

        await action_service.update_action_into_db(
          makeReq({ params: { id: 'action-1' }, body: { status: 'IN_PROGRESS' } }),
        );

        expect(db.update).toHaveBeenCalled();
      });

      it('VIEWER cannot reassign line_of_defense', async () => {
        mockMembership('VIEWER');
        db.findFirst.mockResolvedValue({
          id: 'action-1',
          inspectionId: 'insp-1',
          orgAccountId: ANCHOR,
        });

        await expect(
          action_service.update_action_into_db(
            makeReq({ params: { id: 'action-1' }, body: { line_of_defense: 'FIRST' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(db.update).not.toHaveBeenCalled();
      });

      it('LEAD_AUDITOR assigned to the parent inspection can reassign line_of_defense', async () => {
        mockMembership('LEAD_AUDITOR');
        assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
        db.findFirst.mockResolvedValue({
          id: 'action-1',
          inspectionId: 'insp-assigned-1',
          orgAccountId: ANCHOR,
        });
        db.update.mockResolvedValue({ id: 'action-1', line_of_defense: 'THIRD' });

        await action_service.update_action_into_db(
          makeReq({ params: { id: 'action-1' }, body: { line_of_defense: 'THIRD' } }),
        );

        const callArg = db.update.mock.calls[0][0];
        expect(callArg.data.line_of_defense).toBe('THIRD');
      });

      it('ADMIN can reassign line_of_defense', async () => {
        mockMembership('ADMIN');
        db.findFirst.mockResolvedValue({
          id: 'action-1',
          inspectionId: 'insp-1',
          orgAccountId: ANCHOR,
        });
        db.update.mockResolvedValue({ id: 'action-1', line_of_defense: 'FIRST' });

        await action_service.update_action_into_db(
          makeReq({ params: { id: 'action-1' }, body: { line_of_defense: 'FIRST' } }),
        );

        const callArg = db.update.mock.calls[0][0];
        expect(callArg.data.line_of_defense).toBe('FIRST');
      });
    });

    describe('record_action_line_review (#97)', () => {
      it('throws 404 and does not record a review for another org action', async () => {
        db.findFirst.mockResolvedValue(null);

        await expect(
          action_service.record_action_line_review(
            makeReq({ params: { id: 'org-b-action' }, body: { line: 'SECOND' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 404 });

        expect(actionLineReviewDb.create).not.toHaveBeenCalled();
      });

      it('LEAD_AUDITOR can record a THIRD-line review (audit-line self-check)', async () => {
        mockMembership('LEAD_AUDITOR');
        db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ANCHOR });
        actionLineReviewDb.create.mockResolvedValue({ id: 'rev-1' });
        actionLineReviewDb.findMany.mockResolvedValue([{ id: 'rev-1', line: 'THIRD' }]);

        await action_service.record_action_line_review(
          makeReq({ params: { id: 'a1' }, body: { line: 'THIRD' } }),
        );

        expect(actionLineReviewDb.create).toHaveBeenCalled();
      });

      // Third-line independence, same split as ownership reassignment
      // (aexa-frontend#208): a LEAD_AUDITOR may vouch for THIRD-line review,
      // but not for FIRST/SECOND/GOVERNING_BODY -- those are management-line
      // judgment calls.
      it('LEAD_AUDITOR cannot record a SECOND-line review', async () => {
        mockMembership('LEAD_AUDITOR');
        db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ANCHOR });

        await expect(
          action_service.record_action_line_review(
            makeReq({ params: { id: 'a1' }, body: { line: 'SECOND' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(actionLineReviewDb.create).not.toHaveBeenCalled();
      });

      it('ADMIN can record a FIRST-line review', async () => {
        mockMembership('ADMIN');
        db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ANCHOR });
        actionLineReviewDb.create.mockResolvedValue({ id: 'rev-2' });
        actionLineReviewDb.findMany.mockResolvedValue([{ id: 'rev-2', line: 'FIRST' }]);

        await action_service.record_action_line_review(
          makeReq({ params: { id: 'a1' }, body: { line: 'FIRST' } }),
        );

        expect(actionLineReviewDb.create).toHaveBeenCalled();
      });

      it('ADMIN cannot record a THIRD-line review (audit independence -- management cannot vouch for audit)', async () => {
        mockMembership('ADMIN');
        db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ANCHOR });

        await expect(
          action_service.record_action_line_review(
            makeReq({ params: { id: 'a1' }, body: { line: 'THIRD' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(actionLineReviewDb.create).not.toHaveBeenCalled();
      });

      // A fresh review for the same line supersedes (invalidates) the prior
      // live one rather than stacking duplicates -- see
      // line_of_defense_review.ts's recordLineReview.
      it('invalidates the prior live review for the same line before creating the new one', async () => {
        mockMembership('ADMIN');
        db.findFirst.mockResolvedValue({ id: 'a1', orgAccountId: ANCHOR });
        actionLineReviewDb.create.mockResolvedValue({ id: 'rev-3' });
        actionLineReviewDb.findMany.mockResolvedValue([{ id: 'rev-3', line: 'FIRST' }]);

        await action_service.record_action_line_review(
          makeReq({ params: { id: 'a1' }, body: { line: 'FIRST', notes: 'looks fine' } }),
        );

        expect(actionLineReviewDb.updateMany).toHaveBeenCalledWith({
          where: { actionId: 'a1', line: 'FIRST', invalidatedAt: null },
          data: { invalidatedAt: expect.any(Date) },
        });
        expect(actionLineReviewDb.create).toHaveBeenCalledWith({
          data: { actionId: 'a1', line: 'FIRST', reviewedById: ORG_A, notes: 'looks fine' },
        });
      });

      it('editing an action invalidates every live line review -- the reviewed version is now stale', async () => {
        mockMembership('ADMIN');
        db.findFirst.mockResolvedValue({ id: 'a1', inspectionId: 'insp-1', orgAccountId: ANCHOR });
        db.update.mockResolvedValue({ id: 'a1', actionTitle: 'Renamed' });

        await action_service.update_action_into_db(
          makeReq({ params: { id: 'a1' }, body: { actionTitle: 'Renamed' } }),
        );

        expect(actionLineReviewDb.updateMany).toHaveBeenCalledWith({
          where: { actionId: 'a1', invalidatedAt: null },
          data: { invalidatedAt: expect.any(Date) },
        });
      });
    });

    describe('message visibility (issue #311)', () => {
      it('LIGHT_USER reading a finding only gets CLIENT_VISIBLE messages, not INTERNAL', async () => {
        mockMembership('LIGHT_USER');
        findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
        db.findFirst.mockResolvedValue({ id: 'action-1', orgAccountId: ANCHOR });

        await action_service.get_single_action_from_db(makeReq({ params: { id: 'action-1' } }));

        const [findArg] = db.findFirst.mock.calls[0];
        expect(findArg.include.messages.where).toEqual({ visibility: 'CLIENT_VISIBLE' });
      });

      it.each(['ADMIN', 'LEAD_AUDITOR', 'VIEWER'] as const)(
        '%s reading a finding sees every message, INTERNAL and CLIENT_VISIBLE alike',
        async (role) => {
          mockMembership(role);
          if (role === 'LEAD_AUDITOR') {
            assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-1' }]);
          }
          if (role === 'VIEWER') {
            // Never-assigned Viewer falls back to org-wide (see
            // applyViewerAssignmentScope) — an empty array, not undefined,
            // matters here since getInspectionAssignmentState calls .map on
            // the result.
            assignmentDb.findMany.mockResolvedValue([]);
          }
          db.findFirst.mockResolvedValue({
            id: 'action-1',
            inspectionId: 'insp-1',
            orgAccountId: ANCHOR,
          });

          await action_service.get_single_action_from_db(makeReq({ params: { id: 'action-1' } }));

          const [findArg] = db.findFirst.mock.calls[0];
          expect(findArg.include.messages.where).toBeUndefined();
        },
      );

      it("LIGHT_USER's message-count badge on the list endpoint also excludes INTERNAL messages", async () => {
        mockMembership('LIGHT_USER');
        db.findMany.mockResolvedValue([]);
        db.count.mockResolvedValue(0);

        await action_service.get_all_action_from_db(makeReq());

        const [findArg] = db.findMany.mock.calls[0];
        expect(findArg.include.messages.where).toEqual({ visibility: 'CLIENT_VISIBLE' });
      });

      it('ADMIN sees the unfiltered message count on the list endpoint', async () => {
        mockMembership('ADMIN');
        db.findMany.mockResolvedValue([]);
        db.count.mockResolvedValue(0);

        await action_service.get_all_action_from_db(makeReq());

        const [findArg] = db.findMany.mock.calls[0];
        expect(findArg.include.messages.where).toBeUndefined();
      });

      it('update_action_messages_into_db filters the returned message list for a LIGHT_USER', async () => {
        mockMembership('LIGHT_USER');
        findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
        db.findFirst.mockResolvedValue({
          id: 'action-1',
          orgAccountId: ANCHOR,
          inspectionId: 'insp-1',
        });
        db.update.mockResolvedValue({ id: 'action-1', messages: [] });

        await action_service.update_action_messages_into_db(
          makeReq({ params: { id: 'action-1' }, body: { message: 'hi' } }),
        );

        const callArg = db.update.mock.calls[0][0];
        expect(callArg.include.messages.where).toEqual({ visibility: 'CLIENT_VISIBLE' });
      });

      it('update_action_messages_into_db returns every message for an ADMIN', async () => {
        mockMembership('ADMIN');
        db.findFirst.mockResolvedValue({
          id: 'action-1',
          orgAccountId: ANCHOR,
          inspectionId: 'insp-1',
        });
        db.update.mockResolvedValue({ id: 'action-1', messages: [] });

        await action_service.update_action_messages_into_db(
          makeReq({ params: { id: 'action-1' }, body: { message: 'hi' } }),
        );

        const callArg = db.update.mock.calls[0][0];
        expect(callArg.include.messages.where).toBeUndefined();
      });
    });

    // aexa-server#315: #312's INTERNAL-visibility filtering regressed a
    // LIGHT_USER's ability to see their own just-written message, since
    // update_action_messages_into_db never defaulted a created message's
    // visibility away from the schema's own INTERNAL default. Fixed by
    // defaulting to CLIENT_VISIBLE specifically for callers who can't see
    // INTERNAL messages, leaving everyone else's default untouched.
    describe('message visibility default on write (issue #315)', () => {
      it('LIGHT_USER posting a message with no explicit visibility sees it in the create response', async () => {
        mockMembership('LIGHT_USER');
        findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
        db.findFirst.mockResolvedValue({
          id: 'action-1',
          orgAccountId: ANCHOR,
          inspectionId: 'insp-1',
        });
        db.update.mockResolvedValue({
          id: 'action-1',
          messages: [
            { id: 'msg-1', message: 'hi', senderAccountId: ORG_A, visibility: 'CLIENT_VISIBLE' },
          ],
        });

        const result = await action_service.update_action_messages_into_db(
          makeReq({ params: { id: 'action-1' }, body: { message: 'hi' } }),
        );

        const callArg = db.update.mock.calls[0][0];
        // Created with the CLIENT_VISIBLE default instead of falling through
        // to the schema's INTERNAL default.
        expect(callArg.data.messages.create).toEqual({
          senderAccountId: ORG_A,
          message: 'hi',
          visibility: 'CLIENT_VISIBLE',
        });
        // And the response's own message-visibility filter
        // (messagesInclude(canViewInternalMessages(ctx))) doesn't strip it
        // back out — the LIGHT_USER's own message survives the CLIENT_VISIBLE-only
        // where clause used for their role.
        expect(callArg.include.messages.where).toEqual({ visibility: 'CLIENT_VISIBLE' });
        expect(result.messages).toEqual([
          { id: 'msg-1', message: 'hi', senderAccountId: ORG_A, visibility: 'CLIENT_VISIBLE' },
        ]);
      });

      it('LIGHT_USER posting a message still sees it on a subsequent read (get_single_action_from_db)', async () => {
        mockMembership('LIGHT_USER');
        findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
        db.findFirst.mockResolvedValue({
          id: 'action-1',
          orgAccountId: ANCHOR,
          inspectionId: 'insp-1',
          messages: [
            { id: 'msg-1', message: 'hi', senderAccountId: ORG_A, visibility: 'CLIENT_VISIBLE' },
          ],
        });

        const result = await action_service.get_single_action_from_db(
          makeReq({ params: { id: 'action-1' } }),
        );

        // Same CLIENT_VISIBLE-only where clause as every other LIGHT_USER
        // read — the message created with the new default is a normal
        // CLIENT_VISIBLE row, so it comes back like any other.
        const [findArg] = db.findFirst.mock.calls[0];
        expect(findArg.include.messages.where).toEqual({ visibility: 'CLIENT_VISIBLE' });
        expect(result.messages).toEqual([
          { id: 'msg-1', message: 'hi', senderAccountId: ORG_A, visibility: 'CLIENT_VISIBLE' },
        ]);
      });

      // VIEWER is deliberately excluded here: assertCanWriteToAction never
      // permits a VIEWER to write to a finding at all (read + comment/flag
      // only, per that function's own docstring), so there's no write-path
      // visibility-default behavior to confirm for that role — it 403s
      // before reaching the message-create code this test targets.
      it.each(['ADMIN', 'LEAD_AUDITOR'] as const)(
        '%s posting a message with no explicit visibility still gets the schema INTERNAL default (unchanged)',
        async (role) => {
          mockMembership(role);
          if (role === 'LEAD_AUDITOR') {
            assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-1' }]);
          }
          db.findFirst.mockResolvedValue({
            id: 'action-1',
            orgAccountId: ANCHOR,
            inspectionId: 'insp-1',
          });
          db.update.mockResolvedValue({ id: 'action-1', messages: [] });

          await action_service.update_action_messages_into_db(
            makeReq({ params: { id: 'action-1' }, body: { message: 'hi' } }),
          );

          const callArg = db.update.mock.calls[0][0];
          expect(callArg.data.messages.create).toEqual({
            senderAccountId: ORG_A,
            message: 'hi',
          });
          expect(callArg.data.messages.create).not.toHaveProperty('visibility');
        },
      );

      it('an explicit visibility from a LIGHT_USER caller is respected as-is, not silently overridden', async () => {
        mockMembership('LIGHT_USER');
        findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
        db.findFirst.mockResolvedValue({
          id: 'action-1',
          orgAccountId: ANCHOR,
          inspectionId: 'insp-1',
        });
        db.update.mockResolvedValue({ id: 'action-1', messages: [] });

        await action_service.update_action_messages_into_db(
          makeReq({
            params: { id: 'action-1' },
            body: { message: 'hi', visibility: 'INTERNAL' },
          }),
        );

        const callArg = db.update.mock.calls[0][0];
        // Not overridden to CLIENT_VISIBLE even though this caller can't
        // see INTERNAL messages back — the explicit value always wins.
        expect(callArg.data.messages.create).toEqual({
          senderAccountId: ORG_A,
          message: 'hi',
          visibility: 'INTERNAL',
        });
      });

      it('an explicit visibility from an ADMIN caller is respected as-is, not silently defaulted', async () => {
        mockMembership('ADMIN');
        db.findFirst.mockResolvedValue({
          id: 'action-1',
          orgAccountId: ANCHOR,
          inspectionId: 'insp-1',
        });
        db.update.mockResolvedValue({ id: 'action-1', messages: [] });

        await action_service.update_action_messages_into_db(
          makeReq({
            params: { id: 'action-1' },
            body: { message: 'hi', visibility: 'CLIENT_VISIBLE' },
          }),
        );

        const callArg = db.update.mock.calls[0][0];
        expect(callArg.data.messages.create).toEqual({
          senderAccountId: ORG_A,
          message: 'hi',
          visibility: 'CLIENT_VISIBLE',
        });
      });
    });

    // aexa-server#315: create_action_into_db's `include: { messages: true }`
    // was the one read of the messages relation not routed through the
    // shared messagesInclude() helper #312 introduced — it returned every
    // message regardless of visibility, inconsistent with the other 3 read
    // paths.
    describe('create_action_into_db message-read consistency (issue #315)', () => {
      it('LIGHT_USER creating (via a role that can create) with pre-existing messages only gets CLIENT_VISIBLE ones back', async () => {
        // LIGHT_USER can't create actions (assertCanWriteToInspection denies
        // it), so this exercises the include shape via LEAD_AUDITOR — the
        // point is confirming the include is now routed through
        // messagesInclude(canViewInternalMessages(ctx)) like every other read,
        // not asserting a LIGHT_USER can reach this endpoint.
        mockMembership('LEAD_AUDITOR');
        assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-1' }]);
        dbInspection.findFirst.mockResolvedValue({
          id: 'insp-1',
          siteId: 'site-1',
          orgAccountId: ANCHOR,
        });
        db.create.mockResolvedValue({ id: 'new', orgAccountId: ANCHOR, messages: [] });

        await action_service.create_action_into_db(
          makeReq({ body: { inspectionId: 'insp-1', actionTitle: 'x' } }),
        );

        const callArg = db.create.mock.calls[0][0];
        // `where` being undefined alone doesn't distinguish the fix from the
        // old `messages: true` shorthand (`true.where` is also undefined) --
        // assert the actual messagesInclude() shape (a nested select) is
        // present, which `messages: true` never produced.
        expect(callArg.include.messages).not.toBe(true);
        expect(callArg.include.messages.where).toBeUndefined();
        expect(callArg.include.messages.select).toEqual(
          expect.objectContaining({ id: true, message: true, visibility: true }),
        );
      });

      it("a fresh action's create response for a LIGHT_USER-visible scenario filters messages the same way as get_single_action_from_db", async () => {
        // Simulates the include shape a LIGHT_USER caller would get if they
        // ever reached this path (defense-in-depth: even though
        // assertCanWriteToInspection blocks LIGHT_USER from create today,
        // the include itself must not silently leak INTERNAL messages if
        // that gate ever changes).
        orgMemberDb.findUnique.mockResolvedValue({
          id: MEMBER_ID,
          organizationId: ORG_ID,
          accountId: ORG_A,
          role: 'LIGHT_USER',
          status: 'ACTIVE',
          expiresAt: null,
        });
        organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ANCHOR });
        dbInspection.findFirst.mockResolvedValue({
          id: 'insp-1',
          siteId: 'site-1',
          orgAccountId: ANCHOR,
        });
        db.create.mockResolvedValue({ id: 'new', orgAccountId: ANCHOR, messages: [] });

        // assertCanWriteToInspection throws for LIGHT_USER before the create
        // call is even made — confirm the include shape passed to
        // db.create is never reached in that case (i.e. this stays a 403,
        // not a silent bypass), by asserting the rejection instead.
        await expect(
          action_service.create_action_into_db(
            makeReq({ body: { inspectionId: 'insp-1', actionTitle: 'x' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(db.create).not.toHaveBeenCalled();
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
      findingAssignmentDb.updateMany.mockResolvedValue({ count: 1 });
      findingAssignmentDb.findUniqueOrThrow.mockResolvedValue({
        id: 'fa-1',
        status: 'ACTIVE',
        approvedById: ORG_A,
      });

      const result = await action_service.approve_finding_assignment(
        makeReq({ params: { id: 'fa-1' } }),
      );

      expect(findingAssignmentDb.updateMany).toHaveBeenCalledWith({
        where: { id: 'fa-1', status: 'PENDING_APPROVAL', revokedAt: null },
        data: { status: 'ACTIVE', approvedById: ORG_A },
      });
      expect(result.status).toBe('ACTIVE');
    });

    it('non-ADMIN cannot approve a finding assignment', async () => {
      mockMembership('LEAD_AUDITOR');

      await expect(
        action_service.approve_finding_assignment(makeReq({ params: { id: 'fa-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
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

      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT approve an assignment belonging to another org', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue(null);

      await expect(
        action_service.approve_finding_assignment(makeReq({ params: { id: 'org-b-fa' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
    });

    it('LIGHT_USER cannot approve their own pending finding assignment (self-approval)', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        action_service.approve_finding_assignment(
          makeReq({ user: { accountId: ORG_A }, params: { id: 'fa-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.findFirst).not.toHaveBeenCalled();
      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
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

      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
    });

    // aexa-server#266: maker-checker separation -- the admin who CREATED the
    // sub-assignment (assignedById) can never be the one who approves it,
    // mirroring risk.approval.service.ts's approve_risk and action.closure.
    // service.ts's approve_action_closure. This is distinct from the
    // "LIGHT_USER cannot approve" test above, which blocks on role
    // (assertIsOrgAdmin) before ever reaching the assignment -- this one is
    // an ADMIN who is correctly authorized by role but is also the creator.
    it('BLOCKS self-approval: the ADMIN who created the assignment cannot approve their own submission (403)', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        assignedById: ORG_A,
        status: 'PENDING_APPROVAL',
        revokedAt: null,
      });

      await expect(
        action_service.approve_finding_assignment(makeReq({ params: { id: 'fa-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
    });

    it('a DIFFERENT admin may approve an assignment they did not create', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        assignedById: 'some-other-admin-account-id',
        status: 'PENDING_APPROVAL',
        revokedAt: null,
      });
      findingAssignmentDb.updateMany.mockResolvedValue({ count: 1 });
      findingAssignmentDb.findUniqueOrThrow.mockResolvedValue({
        id: 'fa-1',
        status: 'ACTIVE',
        approvedById: ORG_A,
      });

      const result = await action_service.approve_finding_assignment(
        makeReq({ params: { id: 'fa-1' } }),
      );

      expect(result.status).toBe('ACTIVE');
    });

    // Concurrency race (aexa-server#267): two admins approve/reject the same
    // pending assignment. The first flips it; the second's guarded
    // updateMany matches 0 rows (status is no longer PENDING_APPROVAL) and
    // must yield a clean 409, not a duplicate transition and not a raw 500.
    it('returns a clean 409 (not 500) when the assignment was already decided concurrently', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        status: 'PENDING_APPROVAL', // read-time state; the concurrent write lands next
        revokedAt: null,
      });
      // The guarded updateMany matched nothing -- a concurrent request
      // already moved it out of the PENDING_APPROVAL/non-revoked state.
      findingAssignmentDb.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        action_service.approve_finding_assignment(makeReq({ params: { id: 'fa-1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      // No re-read, no audit event for a transition this request didn't perform.
      expect(findingAssignmentDb.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(prisma.orgAuditLog.create).not.toHaveBeenCalled();
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
      findingAssignmentDb.updateMany.mockResolvedValue({ count: 1 });
      findingAssignmentDb.findUniqueOrThrow.mockResolvedValue({
        id: 'fa-1',
        status: 'REJECTED',
        approvedById: ORG_A,
      });

      const result = await action_service.reject_finding_assignment(
        makeReq({ params: { id: 'fa-1' } }),
      );

      expect(findingAssignmentDb.updateMany).toHaveBeenCalledWith({
        where: { id: 'fa-1', status: 'PENDING_APPROVAL', revokedAt: null },
        data: { status: 'REJECTED', approvedById: ORG_A },
      });
      expect(result.status).toBe('REJECTED');
    });

    it('non-ADMIN cannot reject a finding assignment', async () => {
      mockMembership('LEAD_AUDITOR');

      await expect(
        action_service.reject_finding_assignment(makeReq({ params: { id: 'fa-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
    });

    it('LIGHT_USER cannot reject their own pending finding assignment (self-rejection)', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        action_service.reject_finding_assignment(
          makeReq({ user: { accountId: ORG_A }, params: { id: 'fa-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.findFirst).not.toHaveBeenCalled();
      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT reject an assignment belonging to another org', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue(null);

      await expect(
        action_service.reject_finding_assignment(makeReq({ params: { id: 'org-b-fa' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
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

      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
    });

    // aexa-server#266: same maker-checker reasoning as approve_finding_
    // assignment above -- distinct from the "LIGHT_USER cannot reject" test
    // (which blocks on role), this is an ADMIN correctly authorized by role
    // who is also the assignment's creator.
    it('BLOCKS self-rejection: the ADMIN who created the assignment cannot reject their own submission (403)', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        assignedById: ORG_A,
        status: 'PENDING_APPROVAL',
        revokedAt: null,
      });

      await expect(
        action_service.reject_finding_assignment(makeReq({ params: { id: 'fa-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(findingAssignmentDb.updateMany).not.toHaveBeenCalled();
    });

    // Concurrency race (aexa-server#267): mirrors the approve-side test.
    it('returns a clean 409 (not 500) when the assignment was already decided concurrently', async () => {
      mockMembership('ADMIN');
      findingAssignmentDb.findFirst.mockResolvedValue({
        id: 'fa-1',
        actionId: 'action-1',
        orgMemberId: LIGHT_USER_MEMBER_ID,
        status: 'PENDING_APPROVAL',
        revokedAt: null,
      });
      findingAssignmentDb.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        action_service.reject_finding_assignment(makeReq({ params: { id: 'fa-1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(findingAssignmentDb.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(prisma.orgAuditLog.create).not.toHaveBeenCalled();
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
    // aexa-server#252: update_action_for_external_member now wraps its
    // update + closure-invalidation-on-edit hook in a $transaction too.
    txFn.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
    closureDb.findMany.mockResolvedValue([]);
    // Default (#97): invalidateLiveLineReviews's updateMany is a no-op call
    // on every edit unless a specific test asserts on it.
    actionLineReviewDb.updateMany.mockResolvedValue({ count: 0 });
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

    it('issue #311: excludes INTERNAL messages for the external member, unconditionally', async () => {
      findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
      db.findFirst.mockResolvedValue({ id: 'action-1', orgAccountId: ANCHOR });

      await action_service.get_single_action_for_external_member(
        makeReq({
          params: { id: 'action-1' },
          externalMember: { externalOrgMemberId: EXTERNAL_MEMBER_ID, organizationId: ANCHOR },
        } as never),
      );

      const [findArg] = db.findFirst.mock.calls[0];
      expect(findArg.include.messages.where).toEqual({ visibility: 'CLIENT_VISIBLE' });
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

    // aexa-server#252: an external Light User is exactly the "person
    // remediating closes their own finding" case this ticket exists to fix.
    it.each(['COMPLETE', 'CANT_DO'])(
      'rejects a direct PATCH setting status: %s',
      async (status) => {
        db.findFirst.mockResolvedValue({ id: 'action-1', orgAccountId: ANCHOR });
        findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });

        await expect(
          action_service.update_action_for_external_member(
            makeReq({
              params: { id: 'action-1' },
              body: { status },
              externalMember: { externalOrgMemberId: EXTERNAL_MEMBER_ID, organizationId: ANCHOR },
            } as never),
          ),
        ).rejects.toMatchObject({ statusCode: 400 });

        expect(db.update).not.toHaveBeenCalled();
      },
    );

    it('invalidates a live closure cycle when an external Light User edits the finding, using orgId from ExternalCallerContext', async () => {
      const REAL_ORG_ID = 'real-org-00000000-0000-0000-0000-000000000252';
      db.findFirst.mockResolvedValue({ id: 'action-1', orgAccountId: ANCHOR });
      findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
      db.update.mockResolvedValue({ id: 'action-1' });
      closureDb.findMany.mockResolvedValue([{ id: 'ca-1', status: 'PENDING_APPROVAL' }]);
      closureDb.updateMany.mockResolvedValue({ count: 1 });

      await action_service.update_action_for_external_member(
        makeReq({
          params: { id: 'action-1' },
          body: { actionTitle: 'Revised' },
          externalMember: {
            externalOrgMemberId: EXTERNAL_MEMBER_ID,
            organizationId: ANCHOR,
            orgId: REAL_ORG_ID,
          },
        } as never),
      );

      expect(closureDb.updateMany).toHaveBeenCalledWith({
        where: {
          actionId: 'action-1',
          invalidatedAt: null,
          status: { in: ['PENDING_APPROVAL', 'APPROVED'] },
        },
        data: { invalidatedAt: expect.any(Date), invalidatedById: EXTERNAL_MEMBER_ID },
      });
      // The crux of the fix: the audit write must use orgId (the real
      // Organization.id), NOT organizationId (the anchor Account.id) —
      // those are two different fields on ExternalCallerContext.
      const [auditArg] = (prisma.orgAuditLog.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(auditArg.data).toMatchObject({ organizationId: REAL_ORG_ID });
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

    // aexa-server#244: an external Light User works the remediation, not
    // the formal finding characterization — criteria/condition/cause/effect
    // (and auditEngagementId, which is set-once-at-creation-only anyway) are
    // silently dropped, not persisted, even if supplied in the body.
    it('ignores criteria/condition/cause/effect and auditEngagementId supplied in the body', async () => {
      db.findFirst.mockResolvedValue({ id: 'action-1', orgAccountId: ANCHOR });
      findingAssignmentDb.findFirst.mockResolvedValue({ id: 'fa-1' });
      db.update.mockResolvedValue({ id: 'action-1', status: 'IN_PROGRESS' });

      await action_service.update_action_for_external_member(
        makeReq({
          params: { id: 'action-1' },
          body: {
            status: 'IN_PROGRESS',
            criteria: 'Attempted criteria override',
            condition: 'Attempted condition override',
            cause: 'Attempted cause override',
            effect: 'Attempted effect override',
            auditEngagementId: 'attempted-engagement-repoint',
          },
          externalMember: { externalOrgMemberId: EXTERNAL_MEMBER_ID, organizationId: ANCHOR },
        } as never),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).not.toHaveProperty('criteria');
      expect(callArg.data).not.toHaveProperty('condition');
      expect(callArg.data).not.toHaveProperty('cause');
      expect(callArg.data).not.toHaveProperty('effect');
      expect(callArg.data).not.toHaveProperty('auditEngagementId');
    });
  });
});
