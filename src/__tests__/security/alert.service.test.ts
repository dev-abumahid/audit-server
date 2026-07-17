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
    it('is NOT role-gated — a VIEWER can mark an alert read', async () => {
      mockMembership('VIEWER');
      db.findFirst.mockResolvedValue({ id: 'a1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'a1', is_read: true });

      const result = await alert_service.mark_alert_read_into_db(
        makeReq({ params: { id: 'a1' }, body: { is_read: true } }),
      );

      expect(result.is_read).toBe(true);
      expect(db.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { is_read: true } });
    });

    it('throws 404 for another org alert', async () => {
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
