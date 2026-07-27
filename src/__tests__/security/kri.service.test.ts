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
    kriReading: {
      create: vi.fn(),
      findMany: vi.fn(),
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
    // aexa-server#242: submit_kri_value_into_db now wraps the KRI update,
    // the KriReading insert, and any Alert creation in a $transaction (same
    // pattern as risk.service.ts's #203). The mock runs the interactive
    // callback with the same mocked prisma as the tx client.
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import {
  compute_kri_overdue,
  compute_kri_status,
  kri_service,
} from '../../app/modules/kri/kri.service.js';

const db = prisma.kri as unknown as Record<string, ReturnType<typeof vi.fn>>;
const kriReadingDb = prisma.kriReading as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskDb = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
const alertDb = prisma.alert as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const txFn = (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction;

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

describe('compute_kri_overdue', () => {
  const NOW = new Date('2026-07-26T12:00:00.000Z');
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  it('is false when no frequency is declared', () => {
    expect(compute_kri_overdue(null, daysAgo(365), NOW)).toBe(false);
  });

  it('is false when last_measured_at is unknown', () => {
    expect(compute_kri_overdue('weekly', null, NOW)).toBe(false);
  });

  it('is false for an unrecognized frequency string', () => {
    expect(compute_kri_overdue('biannually', daysAgo(365), NOW)).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(compute_kri_overdue('WEEKLY', daysAgo(10), NOW)).toBe(true);
  });

  it('daily: overdue past 1 day, not overdue within it', () => {
    expect(compute_kri_overdue('daily', daysAgo(2), NOW)).toBe(true);
    expect(compute_kri_overdue('daily', daysAgo(0.5), NOW)).toBe(false);
  });

  it('weekly: overdue past 7 days, not overdue within it', () => {
    expect(compute_kri_overdue('weekly', daysAgo(8), NOW)).toBe(true);
    expect(compute_kri_overdue('weekly', daysAgo(3), NOW)).toBe(false);
  });

  it('monthly: overdue past 30 days, not overdue within it', () => {
    expect(compute_kri_overdue('monthly', daysAgo(31), NOW)).toBe(true);
    expect(compute_kri_overdue('monthly', daysAgo(15), NOW)).toBe(false);
  });

  it('quarterly: overdue past 90 days, not overdue within it', () => {
    expect(compute_kri_overdue('quarterly', daysAgo(91), NOW)).toBe(true);
    expect(compute_kri_overdue('quarterly', daysAgo(45), NOW)).toBe(false);
  });
});

describe('kri service — org scoping and role gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
    txFn.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
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

    // aexa-server#242: overdue is computed at read time (like status) from
    // frequency + last_measured_at, so a list of KRIs can flag a "weekly"
    // one that hasn't been re-measured in 3 months without a background job.
    it('attaches computed overdue per KRI', async () => {
      const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
      const recently = new Date();
      db.findMany.mockResolvedValue([
        {
          id: 'k1',
          current_value: 1,
          alert_threshold: 2,
          target_value: 3,
          frequency: 'weekly',
          last_measured_at: longAgo,
        },
        {
          id: 'k2',
          current_value: 1,
          alert_threshold: 2,
          target_value: 3,
          frequency: 'weekly',
          last_measured_at: recently,
        },
      ]);
      db.count.mockResolvedValue(2);

      const result = await kri_service.get_all_kri_from_db(makeReq());

      expect(result.data[0].overdue).toBe(true);
      expect(result.data[1].overdue).toBe(false);
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

    // aexa-server#242: the value a KRI is created with counts as its first
    // reading, seeded via a nested create so it commits atomically with the
    // Kri row.
    it('seeds the first KriReading and stamps last_measured_at on create', async () => {
      riskDb.findFirst.mockResolvedValue({ id: 'r1', org_account_id: ORG_A });
      db.create.mockResolvedValue({
        id: 'k1',
        current_value: 5,
        alert_threshold: 2,
        target_value: 3,
      });

      await kri_service.create_kri_into_db(
        makeReq({ body: { risk_id: 'r1', current_value: 5, alert_threshold: 2, target_value: 3 } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.last_measured_at).toBeInstanceOf(Date);
      expect(callArg.data.readings).toMatchObject({
        create: { org_account_id: ORG_A, value: 5 },
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

  // Issue #97: Three Lines of Defense classification. update_kri_into_db
  // already gates its entire payload with assertCanWriteOrgResource (ADMIN /
  // LEAD_AUDITOR only) — these tests confirm line_of_defense specifically
  // rides that same existing gate and is actually persisted when allowed.
  describe('update_kri_into_db — line_of_defense (#97)', () => {
    const existingKri = {
      id: 'k1',
      org_account_id: ORG_A,
      alert_threshold: 30,
      target_value: 20,
    };

    it('LIGHT_USER cannot reassign line_of_defense', async () => {
      mockMembership('LIGHT_USER');
      db.findFirst.mockResolvedValue(existingKri);

      await expect(
        kri_service.update_kri_into_db(
          makeReq({ params: { id: 'k1' }, body: { line_of_defense: 'FIRST' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('VIEWER cannot reassign line_of_defense', async () => {
      mockMembership('VIEWER');
      db.findFirst.mockResolvedValue(existingKri);

      await expect(
        kri_service.update_kri_into_db(
          makeReq({ params: { id: 'k1' }, body: { line_of_defense: 'THIRD' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('ADMIN can reassign line_of_defense', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue(existingKri);
      db.update.mockResolvedValue({ ...existingKri, line_of_defense: 'THIRD' });

      await kri_service.update_kri_into_db(
        makeReq({ params: { id: 'k1' }, body: { line_of_defense: 'THIRD' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.line_of_defense).toBe('THIRD');
    });

    // aexa-frontend#208: third-line independence — a LEAD_AUDITOR (third
    // line) must not be able to reclassify a first/second-line entity's
    // (Kri's) ownership. Only ADMIN may reassign Kri.line_of_defense now.
    it('LEAD_AUDITOR cannot reassign line_of_defense (third-line independence)', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findFirst.mockResolvedValue(existingKri);

      await expect(
        kri_service.update_kri_into_db(
          makeReq({ params: { id: 'k1' }, body: { line_of_defense: 'FIRST' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR can still update other fields on the same request as long as line_of_defense is untouched', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findFirst.mockResolvedValue(existingKri);
      db.update.mockResolvedValue({ ...existingKri, name: 'Renamed' });

      await kri_service.update_kri_into_db(
        makeReq({ params: { id: 'k1' }, body: { name: 'Renamed' } }),
      );

      expect(db.update).toHaveBeenCalled();
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

      const updateCallArg = db.updateMany.mock.calls[0][0];
      expect(updateCallArg.where).toEqual({ id: 'k1', updatedAt: readAt });
      expect(updateCallArg.data.current_value).toBe(42);
      // aexa-server#242: last_measured_at is stamped on every submission.
      expect(updateCallArg.data.last_measured_at).toBeInstanceOf(Date);

      // aexa-server#242: every submission is also a permanent history entry.
      expect(kriReadingDb.create).toHaveBeenCalledTimes(1);
      expect(kriReadingDb.create.mock.calls[0][0].data).toMatchObject({
        org_account_id: ORG_A,
        kri_id: 'k1',
        value: 42,
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

    // aexa-server#242: WARNING is a genuine investigate-now signal per real
    // KRI methodology, not a silent middle state — it now fires its own
    // lower-severity alert on transition, same as ALERT/OK below.
    it('creates a medium-severity Alert when the reading transitions INTO WARNING', async () => {
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

      expect(alertDb.create).toHaveBeenCalledTimes(1);
      const callArg = alertDb.create.mock.calls[0][0];
      expect(callArg.data).toMatchObject({
        kri_id: 'k1',
        type: 'kri_warning_threshold',
        severity: 'medium',
      });
    });

    it('does NOT create a duplicate WARNING Alert when the reading stays in WARNING status', async () => {
      db.findFirst.mockResolvedValue({
        id: 'k1',
        org_account_id: ORG_A,
        name: 'Supplier Lead Time',
        unit: 'days',
        current_value: 24,
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

    // aexa-server#242: recovering to OK from ALERT/WARNING is worth a
    // record too, not just silently dropping off the "needs attention" list.
    it('creates a low-severity recovery Alert when the reading transitions back INTO OK', async () => {
      db.findFirst.mockResolvedValue({
        id: 'k1',
        org_account_id: ORG_A,
        name: 'Supplier Lead Time',
        unit: 'days',
        current_value: 25,
        alert_threshold: 30,
        target_value: 20,
      });
      db.updateMany.mockResolvedValue({ count: 1 });
      db.findFirstOrThrow.mockResolvedValue({
        id: 'k1',
        current_value: 18,
        alert_threshold: 30,
        target_value: 20,
      });

      await kri_service.submit_kri_value_into_db(
        makeReq({ params: { id: 'k1' }, body: { current_value: 18 } }),
      );

      expect(alertDb.create).toHaveBeenCalledTimes(1);
      const callArg = alertDb.create.mock.calls[0][0];
      expect(callArg.data).toMatchObject({
        kri_id: 'k1',
        type: 'kri_recovered',
        severity: 'low',
      });
    });

    it('creates a recovery Alert on a direct ALERT-to-OK transition that skips WARNING entirely', async () => {
      db.findFirst.mockResolvedValue({
        id: 'k1',
        org_account_id: ORG_A,
        name: 'Supplier Lead Time',
        unit: 'days',
        current_value: 40, // ALERT (threshold 30, lower-is-better)
        alert_threshold: 30,
        target_value: 20,
      });
      db.updateMany.mockResolvedValue({ count: 1 });
      db.findFirstOrThrow.mockResolvedValue({
        id: 'k1',
        current_value: 15, // OK — jumps straight past the WARNING band
        alert_threshold: 30,
        target_value: 20,
      });

      await kri_service.submit_kri_value_into_db(
        makeReq({ params: { id: 'k1' }, body: { current_value: 15 } }),
      );

      expect(alertDb.create).toHaveBeenCalledTimes(1);
      const callArg = alertDb.create.mock.calls[0][0];
      expect(callArg.data).toMatchObject({ type: 'kri_recovered', severity: 'low' });
    });

    it('does NOT create a recovery Alert when the reading stays in OK status', async () => {
      db.findFirst.mockResolvedValue({
        id: 'k1',
        org_account_id: ORG_A,
        name: 'Supplier Lead Time',
        unit: 'days',
        current_value: 15,
        alert_threshold: 30,
        target_value: 20,
      });
      db.updateMany.mockResolvedValue({ count: 1 });
      db.findFirstOrThrow.mockResolvedValue({
        id: 'k1',
        current_value: 10,
        alert_threshold: 30,
        target_value: 20,
      });

      await kri_service.submit_kri_value_into_db(
        makeReq({ params: { id: 'k1' }, body: { current_value: 10 } }),
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

  describe('get_kri_readings_from_db', () => {
    it('throws 404 for a KRI in another org', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        kri_service.get_kri_readings_from_db(makeReq({ params: { id: 'org-b-kri' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(kriReadingDb.findMany).not.toHaveBeenCalled();
    });

    it('returns the reading history for the KRI, newest first, org-scoped via the KRI ownership check', async () => {
      db.findFirst.mockResolvedValue({ id: 'k1', org_account_id: ORG_A });
      kriReadingDb.findMany.mockResolvedValue([
        { id: 'read-2', kri_id: 'k1', value: 25, recorded_at: new Date('2026-02-01') },
        { id: 'read-1', kri_id: 'k1', value: 20, recorded_at: new Date('2026-01-01') },
      ]);
      kriReadingDb.count.mockResolvedValue(2);

      const result = await kri_service.get_kri_readings_from_db(makeReq({ params: { id: 'k1' } }));

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'k1', org_account_id: ORG_A } });
      const [callArg] = kriReadingDb.findMany.mock.calls[0];
      expect(callArg.where).toEqual({ kri_id: 'k1' });
      expect(callArg.orderBy).toEqual({ recorded_at: 'desc' });
      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
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
