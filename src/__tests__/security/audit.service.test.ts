import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    auditEngagement: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    risk: {
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

vi.mock('../../app/utils/cloudinary.js', () => ({
  default: vi.fn(),
}));

import { prisma } from '../../app/lib/prisma.js';
import { audit_service } from '../../app/modules/audit/audit.service.js';
import uploadCloud from '../../app/utils/cloudinary.js';

const uploadCloudMock = uploadCloud as unknown as ReturnType<typeof vi.fn>;
const db = prisma.auditEngagement as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskDb = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
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

describe('audit service — org scoping (issue #92)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row — ADMIN-of-self fallback (org anchor ===
    // caller's own accountId), same convention every service test in this
    // suite uses.
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  describe('write-path role scoping (issue #55 slice 3)', () => {
    it('VIEWER cannot create an audit engagement', async () => {
      mockMembership('VIEWER');

      await expect(
        audit_service.create_audit_into_db(
          makeReq({ body: { title: 'Q3 Audit', status: 'planned' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('LIGHT_USER cannot update an audit engagement', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        audit_service.update_audit_into_db(
          makeReq({ params: { id: 'a1' }, body: { title: 'hack' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.findFirst).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('VIEWER cannot delete an audit engagement', async () => {
      mockMembership('VIEWER');

      await expect(
        audit_service.delete_audit_from_db(makeReq({ params: { id: 'a1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.delete).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR (a writer role) can still create — the role gate does not over-block', async () => {
      mockMembership('LEAD_AUDITOR');
      db.create.mockResolvedValue({});

      await audit_service.create_audit_into_db(
        makeReq({ body: { title: 'Q3 Audit', status: 'planned' } }),
      );

      expect(db.create).toHaveBeenCalled();
    });
  });

  describe('update_audit_into_db — org_account_id tamper resistance', () => {
    it('ignores an org_account_id supplied in the body and always writes the caller org anchor', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ORG_A });
      db.update.mockResolvedValue({});

      await audit_service.update_audit_into_db(
        makeReq({
          params: { id: 'a1' },
          body: { title: 'Revised', org_account_id: 'other-org' },
        }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
    });
  });

  describe('get_all_audit_from_db', () => {
    it('filters by caller org', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await audit_service.get_all_audit_from_db(makeReq({ query: {} }));

      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({ org_account_id: ORG_A });
    });

    it('scopes the count query by caller org too', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await audit_service.get_all_audit_from_db(makeReq({ query: {} }));

      const [countArg] = db.count.mock.calls[0];
      expect(countArg.where).toMatchObject({ org_account_id: ORG_A });
    });

    it('includes totalPage in meta, computed via the shared pagination helper', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(23);

      const result = await audit_service.get_all_audit_from_db(
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

    it('defaults to page 1 / limit 10 when no query params are supplied', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      const result = await audit_service.get_all_audit_from_db(makeReq({ query: {} }));

      expect(result.meta).toEqual({
        page: 1,
        limit: 10,
        skip: 0,
        total: 0,
        totalPage: 0,
      });
    });
  });

  describe('get_single_audit_from_db', () => {
    it('includes org_account_id in WHERE clause', async () => {
      db.findUnique.mockResolvedValue({ id: 'a1', org_account_id: ORG_A });

      await audit_service.get_single_audit_from_db(makeReq({ params: { id: 'a1' } }));

      const [callArg] = db.findUnique.mock.calls[0];
      expect(callArg.where).toEqual({ id: 'a1', org_account_id: ORG_A });
      // aexa-frontend#165: the linked-risk join is included so the response can
      // carry a `linked_risks` array.
      expect(callArg.include).toBeDefined();
    });

    it('throws 404 for another org engagement instead of returning null', async () => {
      db.findUnique.mockResolvedValue(null);

      await expect(
        audit_service.get_single_audit_from_db(makeReq({ params: { id: 'org-b-audit' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('create_audit_into_db', () => {
    it('injects org_account_id into the created record', async () => {
      db.create.mockResolvedValue({});

      await audit_service.create_audit_into_db(
        makeReq({ body: { title: 'Q3 Audit', status: 'planned' } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
    });
  });

  describe('update_audit_into_db', () => {
    it('verifies ownership before updating', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ORG_A });
      db.update.mockResolvedValue({});

      await audit_service.update_audit_into_db(
        makeReq({ params: { id: 'a1' }, body: { title: 'Revised' } }),
      );

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'a1', org_account_id: ORG_A } });
      expect(db.update).toHaveBeenCalled();
    });

    it('scopes the update write-clause by org_account_id too, not just id (issue #199)', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ORG_A });
      db.update.mockResolvedValue({});

      await audit_service.update_audit_into_db(
        makeReq({ params: { id: 'a1' }, body: { title: 'Revised' } }),
      );

      const [callArg] = db.update.mock.calls[0];
      // The write itself must carry the org filter (defense in depth against a
      // TOCTOU window between the findFirst check and this update).
      expect(callArg.where).toEqual({ id: 'a1', org_account_id: ORG_A });
    });

    it('persists an explicit null closed_at through to the update data (clears the date) (issue #198)', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'a1', closed_at: null });

      // Simulates the post-validation body the frontend produces when a user
      // clears the End Date field: RequestValidator has already run the zod
      // update schema, which passes null through as null.
      await audit_service.update_audit_into_db(
        makeReq({ params: { id: 'a1' }, body: { closed_at: null } }),
      );

      const [callArg] = db.update.mock.calls[0];
      expect(callArg.data.closed_at).toBeNull();
    });

    it('throws 404 and does NOT update another org engagement', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        audit_service.update_audit_into_db(makeReq({ params: { id: 'org-b-audit' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  // Issue #97: Three Lines of Defense classification. update_audit_into_db
  // already gates its entire payload with assertCanWriteOrgResource (ADMIN /
  // LEAD_AUDITOR only) — these tests confirm line_of_defense specifically
  // rides that same existing gate and is actually persisted when allowed.
  describe('update_audit_into_db — line_of_defense (#97)', () => {
    it('LIGHT_USER cannot reassign line_of_defense', async () => {
      mockMembership('LIGHT_USER');
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ANCHOR });

      await expect(
        audit_service.update_audit_into_db(
          makeReq({ params: { id: 'a1' }, body: { line_of_defense: 'FIRST' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('VIEWER cannot reassign line_of_defense', async () => {
      mockMembership('VIEWER');
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ANCHOR });

      await expect(
        audit_service.update_audit_into_db(
          makeReq({ params: { id: 'a1' }, body: { line_of_defense: 'SECOND' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('ADMIN can reassign line_of_defense', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ANCHOR });
      db.update.mockResolvedValue({ id: 'a1', line_of_defense: 'FIRST' });

      await audit_service.update_audit_into_db(
        makeReq({ params: { id: 'a1' }, body: { line_of_defense: 'FIRST' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.line_of_defense).toBe('FIRST');
    });

    it('LEAD_AUDITOR can reassign line_of_defense', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ANCHOR });
      db.update.mockResolvedValue({ id: 'a1', line_of_defense: 'SECOND' });

      await audit_service.update_audit_into_db(
        makeReq({ params: { id: 'a1' }, body: { line_of_defense: 'SECOND' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.line_of_defense).toBe('SECOND');
    });
  });

  describe('delete_audit_from_db', () => {
    it('verifies ownership before deleting', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ORG_A });
      db.delete.mockResolvedValue({});

      await audit_service.delete_audit_from_db(makeReq({ params: { id: 'a1' } }));

      expect(db.findFirst).toHaveBeenCalledWith({
        where: { id: 'a1', org_account_id: ORG_A },
      });
      expect(db.delete).toHaveBeenCalledWith({
        where: { id: 'a1', org_account_id: ORG_A },
      });
    });

    it('throws 404 and does NOT delete another org engagement', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        audit_service.delete_audit_from_db(makeReq({ params: { id: 'org-b-audit' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  // aexa-frontend#165: linked risks are a real many-to-many relation validated
  // against the caller's org, not free-text tags.
  describe('linked risks — org-scoped M2M relation (aexa-frontend#165)', () => {
    const RISK_1 = 'risk-00000000-0000-0000-0000-000000000001';
    const RISK_2 = 'risk-00000000-0000-0000-0000-000000000002';

    it('create validates the supplied risk ids belong to the caller org, then writes nested link rows', async () => {
      riskDb.count.mockResolvedValue(2); // both ids resolve within ORG_A
      db.create.mockResolvedValue({ id: 'a1', org_account_id: ORG_A, risks: [] });

      await audit_service.create_audit_into_db(
        makeReq({ body: { title: 'Q3 Audit', status: 'planned', riskIds: [RISK_1, RISK_2] } }),
      );

      // The org-scoped validation ran with the exact id set, filtered by org.
      const [countArg] = riskDb.count.mock.calls[0];
      expect(countArg.where).toEqual({ id: { in: [RISK_1, RISK_2] }, org_account_id: ORG_A });

      // The links are written as nested creates, not a scalar column.
      const createArg = db.create.mock.calls[0][0];
      expect(createArg.data.risks).toEqual({
        create: [{ riskId: RISK_1 }, { riskId: RISK_2 }],
      });
      // The dropped free-text column must never be written.
      expect(createArg.data).not.toHaveProperty('linked_risk_refs');
      expect(createArg.data).not.toHaveProperty('riskIds');
    });

    it('create REJECTS a cross-org risk id with 404 and writes nothing', async () => {
      // Only 1 of the 2 ids resolves within ORG_A → the other belongs elsewhere.
      riskDb.count.mockResolvedValue(1);

      await expect(
        audit_service.create_audit_into_db(
          makeReq({ body: { title: 'x', status: 'planned', riskIds: [RISK_1, 'other-org-risk'] } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('create with no riskIds writes no risks relation at all', async () => {
      db.create.mockResolvedValue({ id: 'a1', org_account_id: ORG_A, risks: [] });

      await audit_service.create_audit_into_db(
        makeReq({ body: { title: 'Q3 Audit', status: 'planned' } }),
      );

      expect(riskDb.count).not.toHaveBeenCalled();
      const createArg = db.create.mock.calls[0][0];
      expect(createArg.data).not.toHaveProperty('risks');
    });

    it('update replaces the whole link set when riskIds is an explicit array (deleteMany + create)', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ORG_A });
      riskDb.count.mockResolvedValue(1);
      db.update.mockResolvedValue({ id: 'a1', org_account_id: ORG_A, risks: [] });

      await audit_service.update_audit_into_db(
        makeReq({ params: { id: 'a1' }, body: { riskIds: [RISK_1] } }),
      );

      const updateArg = db.update.mock.calls[0][0];
      expect(updateArg.data.risks).toEqual({
        deleteMany: {},
        create: [{ riskId: RISK_1 }],
      });
    });

    it('update with an explicit empty array clears all links', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'a1', org_account_id: ORG_A, risks: [] });

      await audit_service.update_audit_into_db(
        makeReq({ params: { id: 'a1' }, body: { riskIds: [] } }),
      );

      // No ids to validate, but the relation write still fires to clear links.
      expect(riskDb.count).not.toHaveBeenCalled();
      const updateArg = db.update.mock.calls[0][0];
      expect(updateArg.data.risks).toEqual({ deleteMany: {}, create: [] });
    });

    it('update with riskIds OMITTED leaves existing links untouched (no risks write)', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'a1', org_account_id: ORG_A, risks: [] });

      await audit_service.update_audit_into_db(
        makeReq({ params: { id: 'a1' }, body: { title: 'Just a title change' } }),
      );

      const updateArg = db.update.mock.calls[0][0];
      expect(updateArg.data).not.toHaveProperty('risks');
    });

    it('update REJECTS a cross-org risk id with 404 and does not write', async () => {
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ORG_A });
      riskDb.count.mockResolvedValue(0); // supplied id resolves in no risk of ORG_A

      await expect(
        audit_service.update_audit_into_db(
          makeReq({ params: { id: 'a1' }, body: { riskIds: ['foreign-risk'] } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('de-duplicates repeated ids and drops blanks before validating/writing', async () => {
      riskDb.count.mockResolvedValue(1);
      db.create.mockResolvedValue({ id: 'a1', org_account_id: ORG_A, risks: [] });

      await audit_service.create_audit_into_db(
        makeReq({ body: { title: 'x', status: 'planned', riskIds: [RISK_1, RISK_1, ''] } }),
      );

      const [countArg] = riskDb.count.mock.calls[0];
      expect(countArg.where.id.in).toEqual([RISK_1]);
      const createArg = db.create.mock.calls[0][0];
      expect(createArg.data.risks).toEqual({ create: [{ riskId: RISK_1 }] });
    });

    it('GET single flattens the join rows into a linked_risks array of {id,name,category}', async () => {
      db.findUnique.mockResolvedValue({
        id: 'a1',
        org_account_id: ORG_A,
        risks: [
          { risk: { id: RISK_1, name: 'Data breach', category: 'Cyber' } },
          { risk: { id: RISK_2, name: 'Flood', category: 'Physical' } },
        ],
      });

      const result = await audit_service.get_single_audit_from_db(
        makeReq({ params: { id: 'a1' } }),
      );

      expect(result).not.toHaveProperty('risks'); // internal join shape hidden
      expect(result.linked_risks).toEqual([
        { id: RISK_1, name: 'Data breach', category: 'Cyber' },
        { id: RISK_2, name: 'Flood', category: 'Physical' },
      ]);
    });

    it('GET list flattens linked_risks per row', async () => {
      db.findMany.mockResolvedValue([
        {
          id: 'a1',
          org_account_id: ORG_A,
          risks: [{ risk: { id: RISK_1, name: 'Data breach', category: 'Cyber' } }],
        },
      ]);
      db.count.mockResolvedValue(1);

      const result = await audit_service.get_all_audit_from_db(makeReq({ query: {} }));

      expect(result.data[0].linked_risks).toEqual([
        { id: RISK_1, name: 'Data breach', category: 'Cyber' },
      ]);
    });
  });

  describe('upload_audit_report_into_storage (issue #159 backend half)', () => {
    it('uploads the file and returns its URL for a writer role', async () => {
      mockMembership('LEAD_AUDITOR');
      uploadCloudMock.mockResolvedValue({
        secure_url: 'https://s3.example.com/report-123.pdf',
        key: 'report-123.pdf',
      });

      const result = await audit_service.upload_audit_report_into_storage(
        makeReq({ file: { path: '/tmp/x.pdf' } as unknown as Express.Multer.File }),
      );

      expect(uploadCloudMock).toHaveBeenCalled();
      expect(result).toEqual({ url: 'https://s3.example.com/report-123.pdf' });
    });

    it('rejects a VIEWER (read-only) trying to push a file into org storage', async () => {
      mockMembership('VIEWER');

      await expect(
        audit_service.upload_audit_report_into_storage(
          makeReq({ file: { path: '/tmp/x.pdf' } as unknown as Express.Multer.File }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(uploadCloudMock).not.toHaveBeenCalled();
    });

    it('throws 400 when no file is attached', async () => {
      mockMembership('LEAD_AUDITOR');

      await expect(
        audit_service.upload_audit_report_into_storage(makeReq({})),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(uploadCloudMock).not.toHaveBeenCalled();
    });
  });
});
