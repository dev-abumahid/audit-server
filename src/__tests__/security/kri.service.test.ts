import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, ORG_B, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    kri: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    risk: {
      findFirst: vi.fn(),
    },
    alert: {
      create: vi.fn(),
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
import { compute_kri_status, kri_service } from '../../app/modules/kri/kri.service.js';

const db = prisma.kri as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskDb = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
const alertDb = prisma.alert as unknown as Record<string, ReturnType<typeof vi.fn>>;
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

describe('compute_kri_status', () => {
  it('higher-is-better (target above threshold): OK above target', () => {
    expect(compute_kri_status(90, 50, 80)).toBe('OK');
  });

  it('higher-is-better: ALERT at or below threshold', () => {
    expect(compute_kri_status(40, 50, 80)).toBe('ALERT');
    expect(compute_kri_status(50, 50, 80)).toBe('ALERT');
  });

  it('higher-is-better: WARNING strictly between threshold and target', () => {
    expect(compute_kri_status(65, 50, 80)).toBe('WARNING');
  });

  it('lower-is-better (target below threshold, e.g. Supplier Lead Time): OK at or below target', () => {
    expect(compute_kri_status(15, 30, 20)).toBe('OK');
    expect(compute_kri_status(20, 30, 20)).toBe('OK');
  });

  it('lower-is-better: ALERT at or above threshold', () => {
    expect(compute_kri_status(42, 30, 20)).toBe('ALERT');
  });

  it('lower-is-better: WARNING strictly between target and threshold', () => {
    expect(compute_kri_status(25, 30, 20)).toBe('WARNING');
  });
});

describe('kri service — org scoping and role gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  describe('get_all_kri_from_db', () => {
    it('filters by caller org and attaches computed status', async () => {
      db.findMany.mockResolvedValue([
        { id: 'k1', current_value: 42, alert_threshold: 30, target_value: 20 },
      ]);
      db.count.mockResolvedValue(1);

      const result = await kri_service.get_all_kri_from_db(makeReq());

      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({ org_account_id: ORG_A });
      expect(result.data[0].status).toBe('ALERT');
    });

    // Qiyrix/aexa-server#137 — this endpoint hand-rolled `parseInt(page) ||
    // 1`-style pagination instead of using the shared paginationHelper /
    // buildPaginationMeta, so it never picked up the MAX_LIMIT cap or
    // totalPage that #117/#115/#116/#125 added to every other list endpoint.
    it('includes totalPage in meta, computed via the shared pagination helper', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(23);

      const result = await kri_service.get_all_kri_from_db(
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

      const result = await kri_service.get_all_kri_from_db(
        makeReq({ query: { page: '1', limit: '1000000' } }),
      );

      expect(result.meta.limit).toBe(100);
      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.take).toBe(100);
    });

    it('defaults to page 1 / limit 10 when no query params are supplied', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      const result = await kri_service.get_all_kri_from_db(makeReq({ query: {} }));

      expect(result.meta).toEqual({
        page: 1,
        limit: 10,
        skip: 0,
        total: 0,
        totalPage: 0,
      });
    });
  });

  describe('create_kri_into_db', () => {
    it('VIEWER cannot create a KRI', async () => {
      mockMembership('VIEWER');

      await expect(
        kri_service.create_kri_into_db(
          makeReq({
            body: { risk_id: 'r1', current_value: 1, alert_threshold: 2, target_value: 3 },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('rejects a risk_id belonging to another org', async () => {
      riskDb.findFirst.mockResolvedValue(null);

      await expect(
        kri_service.create_kri_into_db(
          makeReq({
            body: { risk_id: 'org-b-risk', current_value: 1, alert_threshold: 2, target_value: 3 },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('injects org_account_id and creates when the risk belongs to the caller org', async () => {
      riskDb.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.create.mockResolvedValue({
        id: 'k1',
        current_value: 1,
        alert_threshold: 2,
        target_value: 3,
      });

      await kri_service.create_kri_into_db(
        makeReq({ body: { risk_id: 'r1', current_value: 1, alert_threshold: 2, target_value: 3 } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
      expect(riskDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'r1', org_account_id: ORG_A },
      });
    });
  });

  describe('update_kri_into_db', () => {
    it('LIGHT_USER cannot update a KRI', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        kri_service.update_kri_into_db(makeReq({ params: { id: 'k1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('ignores risk_id, org_account_id, and current_value supplied in the body', async () => {
      db.findFirst.mockResolvedValue({
        id: 'k1',
        org_account_id: ORG_A,
        risk_id: 'r1',
        current_value: 10,
        alert_threshold: 30,
        target_value: 20,
      });
      db.update.mockResolvedValue({});

      await kri_service.update_kri_into_db(
        makeReq({
          params: { id: 'k1' },
          body: {
            risk_id: 'org-b-risk',
            org_account_id: ORG_B,
            current_value: 999,
            name: 'Renamed',
          },
        }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
      expect(callArg.data.risk_id).toBeUndefined();
      expect(callArg.data.current_value).toBeUndefined();
      expect(callArg.data.name).toBe('Renamed');
    });

    it("rejects a partial update that would make target_value equal the KRI's existing alert_threshold", async () => {
      db.findFirst.mockResolvedValue({
        id: 'k1',
        org_account_id: ORG_A,
        alert_threshold: 30,
        target_value: 20,
      });

      // Only alert_threshold supplied — kri.validation.ts's refine can't see
      // this would collide with the existing (unsupplied) target_value=20.
      await expect(
        kri_service.update_kri_into_db(
          makeReq({ params: { id: 'k1' }, body: { alert_threshold: 20 } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('throws 404 for another org KRI', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        kri_service.update_kri_into_db(makeReq({ params: { id: 'org-b-kri' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('submit_kri_value_into_db — alert auto-generation', () => {
    it('creates an Alert when a reading crosses INTO ALERT status', async () => {
      const readAt = new Date('2026-07-20T10:00:00.000Z');
      db.findFirst.mockResolvedValue({
        id: 'k1',
        org_account_id: ORG_A,
        name: 'Supplier Lead Time',
        unit: 'days',
        current_value: 25,
        alert_threshold: 30,
        target_value: 20,
        updatedAt: readAt,
      });
      db.updateMany.mockResolvedValue({ count: 1 });
      db.findFirstOrThrow.mockResolvedValue({
        id: 'k1',
        current_value: 42,
        alert_threshold: 30,
        target_value: 20,
      });

      await kri_service.submit_kri_value_into_db(
        makeReq({ params: { id: 'k1' }, body: { current_value: 42 } }),
      );

      expect(db.updateMany).toHaveBeenCalledWith({
        where: { id: 'k1', updatedAt: readAt },
        data: { current_value: 42 },
      });
      expect(alertDb.create).toHaveBeenCalledTimes(1);
      const callArg = alertDb.create.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
      expect(callArg.data.kri_id).toBe('k1');
      expect(callArg.data.severity).toBe('high');
    });

    it('does NOT create a duplicate Alert when the reading stays in ALERT status', async () => {
      db.findFirst.mockResolvedValue({
        id: 'k1',
        org_account_id: ORG_A,
        name: 'Supplier Lead Time',
        unit: 'days',
        current_value: 40,
        alert_threshold: 30,
        target_value: 20,
      });
      db.updateMany.mockResolvedValue({ count: 1 });
      db.findFirstOrThrow.mockResolvedValue({
        id: 'k1',
        current_value: 45,
        alert_threshold: 30,
        target_value: 20,
      });

      await kri_service.submit_kri_value_into_db(
        makeReq({ params: { id: 'k1' }, body: { current_value: 45 } }),
      );

      expect(alertDb.create).not.toHaveBeenCalled();
    });

    it('does NOT create an Alert when the reading only reaches WARNING', async () => {
      db.findFirst.mockResolvedValue({
        id: 'k1',
        org_account_id: ORG_A,
        name: 'Supplier Lead Time',
        unit: 'days',
        current_value: 20,
        alert_threshold: 30,
        target_value: 20,
      });
      db.updateMany.mockResolvedValue({ count: 1 });
      db.findFirstOrThrow.mockResolvedValue({
        id: 'k1',
        current_value: 25,
        alert_threshold: 30,
        target_value: 20,
      });

      await kri_service.submit_kri_value_into_db(
        makeReq({ params: { id: 'k1' }, body: { current_value: 25 } }),
      );

      expect(alertDb.create).not.toHaveBeenCalled();
    });

    it('VIEWER cannot submit a KRI reading', async () => {
      mockMembership('VIEWER');

      await expect(
        kri_service.submit_kri_value_into_db(
          makeReq({ params: { id: 'k1' }, body: { current_value: 1 } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.updateMany).not.toHaveBeenCalled();
      expect(alertDb.create).not.toHaveBeenCalled();
    });

    it('throws 409 and does NOT create an Alert when a concurrent write races the update', async () => {
      db.findFirst.mockResolvedValue({
        id: 'k1',
        org_account_id: ORG_A,
        name: 'Supplier Lead Time',
        unit: 'days',
        current_value: 25,
        alert_threshold: 30,
        target_value: 20,
        updatedAt: new Date('2026-07-20T10:00:00.000Z'),
      });
      // Zero rows matched: another request already changed the row (bumping
      // updatedAt) out from under this one's optimistic-concurrency guard.
      db.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        kri_service.submit_kri_value_into_db(
          makeReq({ params: { id: 'k1' }, body: { current_value: 42 } }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(db.findFirstOrThrow).not.toHaveBeenCalled();
      expect(alertDb.create).not.toHaveBeenCalled();
    });

    it('closes the current_value-keyed TOCTOU gap: a same-value resubmission race still gets a 409, not a double alert', async () => {
      // Regression test for #133. The old guard was `where: { id,
      // current_value: existing.current_value }`. If two concurrent
      // submissions both write the SAME new value as what's already
      // stored, current_value never actually changes across the race, so a
      // value-keyed guard would never see a mismatch — both writes (and
      // both alert-creation decisions) would sail through and double-fire.
      // updatedAt changes on every write regardless of whether the value
      // itself changed, so it correctly detects the second writer.
      const readAt = new Date('2026-07-20T10:00:00.000Z');
      const row = {
        id: 'k1',
        org_account_id: ORG_A,
        name: 'Supplier Lead Time',
        unit: 'days',
        current_value: 25,
        alert_threshold: 30,
        target_value: 20,
        updatedAt: readAt,
      };
      // Both requests read the same pre-update row.
      db.findFirst.mockResolvedValue(row);

      // Simulate the DB: the first writer's updateMany succeeds and bumps
      // updatedAt (even though current_value ends up the same as before —
      // both requests submit 42), so the second writer's guard (still
      // pinned to the original readAt) no longer matches — even though
      // BOTH requests read the row at readAt and both compute the same
      // where clause. Track server-side state explicitly rather than just
      // comparing against readAt, so a second call with an *identical*
      // where clause to the first still correctly loses the race.
      const postWriteUpdatedAt = new Date('2026-07-20T10:00:01.000Z');
      let serverUpdatedAt = readAt;
      db.updateMany.mockImplementation(({ where }: { where: { updatedAt: Date } }) => {
        if (where.updatedAt.getTime() !== serverUpdatedAt.getTime()) {
          return Promise.resolve({ count: 0 });
        }
        serverUpdatedAt = postWriteUpdatedAt;
        return Promise.resolve({ count: 1 });
      });
      db.findFirstOrThrow.mockResolvedValue({
        ...row,
        current_value: 42,
        updatedAt: postWriteUpdatedAt,
      });

      // First request wins.
      await kri_service.submit_kri_value_into_db(
        makeReq({ params: { id: 'k1' }, body: { current_value: 42 } }),
      );
      expect(alertDb.create).toHaveBeenCalledTimes(1);

      // Second request raced in with a read from before the first write
      // landed (same readAt, same new value: 42) — it must be rejected,
      // not silently succeed and fire a duplicate alert.
      await expect(
        kri_service.submit_kri_value_into_db(
          makeReq({ params: { id: 'k1' }, body: { current_value: 42 } }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });

      // Still only the one alert from the winning request.
      expect(alertDb.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('delete_kri_from_db', () => {
    it('VIEWER cannot delete a KRI', async () => {
      mockMembership('VIEWER');

      await expect(
        kri_service.delete_kri_from_db(makeReq({ params: { id: 'k1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.delete).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT delete another org KRI', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        kri_service.delete_kri_from_db(makeReq({ params: { id: 'org-b-kri' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.delete).not.toHaveBeenCalled();
    });
  });
});
