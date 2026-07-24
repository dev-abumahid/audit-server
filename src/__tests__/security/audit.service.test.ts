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
    orgMember: {
      findUnique: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { audit_service } from '../../app/modules/audit/audit.service.js';

const db = prisma.auditEngagement as unknown as Record<string, ReturnType<typeof vi.fn>>;
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

      expect(db.findUnique).toHaveBeenCalledWith({
        where: { id: 'a1', org_account_id: ORG_A },
      });
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

    it('throws 404 and does NOT update another org engagement', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        audit_service.update_audit_into_db(makeReq({ params: { id: 'org-b-audit' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
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
});
