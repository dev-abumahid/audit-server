import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    alert: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    kri: {
      findFirst: vi.fn(),
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
import { alert_service } from '../../app/modules/alert/alert.service.js';

const db = prisma.alert as unknown as Record<string, ReturnType<typeof vi.fn>>;
const kriDb = prisma.kri as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;

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
  organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ORG_A });
};

describe('alert service — org scoping and role gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  describe('get_all_alert_from_db', () => {
    it('filters by caller org', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await alert_service.get_all_alert_from_db(makeReq());

      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({ org_account_id: ORG_A });
    });

    it('applies severity and is_read filters', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await alert_service.get_all_alert_from_db(
        makeReq({ query: { severity: 'critical', is_read: 'false' } }),
      );

      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({
        org_account_id: ORG_A,
        severity: 'critical',
        is_read: false,
      });
    });

    // Qiyrix/aexa-server#137 — this endpoint hand-rolled `parseInt(page) ||
    // 1`-style pagination instead of using the shared paginationHelper /
    // buildPaginationMeta, so it never picked up the MAX_LIMIT cap or
    // totalPage that #117/#115/#116/#125 added to every other list endpoint.
    it('includes totalPage in meta, computed via the shared pagination helper', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(23);

      const result = await alert_service.get_all_alert_from_db(
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

      const result = await alert_service.get_all_alert_from_db(
        makeReq({ query: { page: '1', limit: '1000000' } }),
      );

      expect(result.meta.limit).toBe(100);
      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.take).toBe(100);
    });

    it('defaults to page 1 / limit 10 when no query params are supplied', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      const result = await alert_service.get_all_alert_from_db(makeReq({ query: {} }));

      expect(result.meta).toEqual({
        page: 1,
        limit: 10,
        skip: 0,
        total: 0,
        totalPage: 0,
      });
    });
  });

  describe('create_alert_into_db', () => {
    it('VIEWER cannot create an alert', async () => {
      mockMembership('VIEWER');

      await expect(
        alert_service.create_alert_into_db(
          makeReq({
            body: { source: 'Manual', type: 'Operational', severity: 'high', title: 'x' },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('rejects a kri_id belonging to another org', async () => {
      kriDb.findFirst.mockResolvedValue(null);

      await expect(
        alert_service.create_alert_into_db(
          makeReq({
            body: {
              source: 'Manual',
              type: 'Operational',
              severity: 'high',
              title: 'x',
              kri_id: 'org-b-kri',
            },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('injects org_account_id and forces ai_generated=false for manual alerts', async () => {
      db.create.mockResolvedValue({});

      await alert_service.create_alert_into_db(
        makeReq({
          body: {
            source: 'Manual',
            type: 'Operational',
            severity: 'high',
            title: 'x',
            ai_generated: true,
          },
        }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
      expect(callArg.data.ai_generated).toBe(false);
    });
  });

  describe('mark_alert_read_into_db', () => {
    // Found on audit: `is_read` is a single shared column on Alert (no
    // per-account read-state join table), so marking one read/unread
    // changes what EVERY org member sees, not just the caller's own view.
    // This endpoint previously had no role check at all -- this test used
    // to assert that as intended behavior. Any VIEWER could silently clear
    // the unread flag on a critical alert org-wide. Same role gate as
    // create/delete now.
    it('VIEWER cannot mark an alert read — is_read is an org-wide flag, not a per-viewer acknowledgement', async () => {
      mockMembership('VIEWER');

      await expect(
        alert_service.mark_alert_read_into_db(
          makeReq({ params: { id: 'a1' }, body: { is_read: true } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.findFirst).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('LIGHT_USER cannot mark an alert read', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        alert_service.mark_alert_read_into_db(
          makeReq({ params: { id: 'a1' }, body: { is_read: true } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('ADMIN can mark an alert read', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'a1', is_read: true });

      const result = await alert_service.mark_alert_read_into_db(
        makeReq({ params: { id: 'a1' }, body: { is_read: true } }),
      );

      expect(result.is_read).toBe(true);
      expect(db.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { is_read: true } });
    });

    it('LEAD_AUDITOR can mark an alert read', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'a1', is_read: true });

      const result = await alert_service.mark_alert_read_into_db(
        makeReq({ params: { id: 'a1' }, body: { is_read: true } }),
      );

      expect(result.is_read).toBe(true);
    });

    it('throws 404 for another org alert', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue(null);

      await expect(
        alert_service.mark_alert_read_into_db(
          makeReq({ params: { id: 'org-b-alert' }, body: { is_read: true } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('delete_alert_from_db', () => {
    it('LIGHT_USER cannot delete an alert', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        alert_service.delete_alert_from_db(makeReq({ params: { id: 'a1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.delete).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT delete another org alert', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        alert_service.delete_alert_from_db(makeReq({ params: { id: 'org-b-alert' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.delete).not.toHaveBeenCalled();
    });
  });
});
