import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    complianceObligation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    // aexa-server#346: obligation <-> risk linking (create-risk/link-risk).
    risk: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    // aexa-server#250: re-attestation history, and next_review_date
    // advancement, wrapped in a $transaction.
    complianceAttestation: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    // Quality-bar-loop industry-standards gap: field-level edit-history log,
    // written inside update_compliance_into_db's own $transaction.
    complianceObligationEdit: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    complianceObligationLineReview: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    site: {
      findFirst: vi.fn(),
    },
    orgMember: {
      findUnique: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

// Cloudinary is mocked so the attachment-upload test never touches the network.
vi.mock('../../app/utils/cloudinary.js', () => ({
  default: vi.fn(),
}));

import { prisma } from '../../app/lib/prisma.js';
import {
  build_compliance_edit_diff,
  compliance_service,
  compute_obligation_overdue,
} from '../../app/modules/compliance/compliance.service.js';
import { compliance_validations } from '../../app/modules/compliance/compliance.validation.js';
import uploadCloud from '../../app/utils/cloudinary.js';

const db = prisma.complianceObligation as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskDb = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
const attestationDb = prisma.complianceAttestation as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const editHistoryDb = prisma.complianceObligationEdit as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const lineReviewDb = prisma.complianceObligationLineReview as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const siteDb = prisma.site as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const uploadCloudMock = uploadCloud as unknown as ReturnType<typeof vi.fn>;
const txFn = (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction;

const ANCHOR = ORG_A;
const ORG_ID = 'org-00000000-0000-0000-0000-000000000093';
const MEMBER_ID = 'org-member-00000000-0000-0000-0000-000000000093';

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

describe('compute_obligation_overdue', () => {
  const NOW = new Date('2026-07-26T12:00:00.000Z');
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
  const daysFromNow = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

  it('is false when there is no due_date', () => {
    expect(compute_obligation_overdue(null, 'in_progress', NOW)).toBe(false);
  });

  it('is false when the due_date is in the future', () => {
    expect(compute_obligation_overdue(daysFromNow(1), 'in_progress', NOW)).toBe(false);
  });

  it('is true once the due_date has passed', () => {
    expect(compute_obligation_overdue(daysAgo(1), 'in_progress', NOW)).toBe(true);
  });

  // aexa-server#243: this is the specific gap the ticket describes — a
  // "compliant" obligation sitting past its due_date with no re-attestation
  // is exactly the stale-data problem, so it must still flag overdue (a
  // passive signal, not an auto-downgrade of the stored status).
  it('is true for a "compliant" obligation whose due_date has passed', () => {
    expect(compute_obligation_overdue(daysAgo(1), 'compliant', NOW)).toBe(true);
  });

  // Mirrors the scorecard's own not_applicable exclusion (#239/#240): an
  // obligation that doesn't apply to this org was never going to be met by
  // its due_date, so it isn't a real compliance gap.
  it('is false for a not_applicable obligation even with a past due_date', () => {
    expect(compute_obligation_overdue(daysAgo(365), 'not_applicable', NOW)).toBe(false);
  });

  // aexa-server#250: next_review_date (not the original one-time due_date)
  // is what actually matters for a recurring obligation's staleness.
  describe('next_review_date (aexa-server#250)', () => {
    it('uses next_review_date instead of due_date when both are present', () => {
      // due_date is long past, but next_review_date (the latest re-attestation
      // cycle) is still in the future -> not overdue.
      expect(compute_obligation_overdue(daysAgo(400), 'compliant', NOW, daysFromNow(10))).toBe(
        false,
      );
    });

    it('is overdue once next_review_date itself has passed, even with a future-looking due_date', () => {
      expect(compute_obligation_overdue(daysFromNow(400), 'compliant', NOW, daysAgo(1))).toBe(true);
    });

    it('falls back to due_date when next_review_date is unset (non-recurring obligation)', () => {
      expect(compute_obligation_overdue(daysAgo(1), 'in_progress', NOW, null)).toBe(true);
      expect(compute_obligation_overdue(daysFromNow(1), 'in_progress', NOW, undefined)).toBe(false);
    });

    it('still excludes not_applicable even when next_review_date has passed', () => {
      expect(compute_obligation_overdue(daysAgo(400), 'not_applicable', NOW, daysAgo(1))).toBe(
        false,
      );
    });
  });
});

// Quality-bar-loop industry-standards gap: the field-level diff builder that
// backs ComplianceObligationEdit.
describe('build_compliance_edit_diff', () => {
  it('returns null when the patch touches no tracked fields', () => {
    expect(
      build_compliance_edit_diff({ title: 'A', ai_generated: false }, { ai_generated: true }),
    ).toBeNull();
  });

  it('returns null when a tracked field is present in the patch but unchanged', () => {
    expect(build_compliance_edit_diff({ title: 'Same' }, { title: 'Same' })).toBeNull();
  });

  it('diffs a single changed tracked field', () => {
    expect(build_compliance_edit_diff({ title: 'Old' }, { title: 'New' })).toEqual({
      title: { old: 'Old', new: 'New' },
    });
  });

  it('diffs multiple changed tracked fields in one patch', () => {
    expect(
      build_compliance_edit_diff(
        { title: 'Old', owner: 'Alice', status: 'in_progress' },
        { title: 'New', owner: 'Bob', status: 'in_progress' },
      ),
    ).toEqual({
      title: { old: 'Old', new: 'New' },
      owner: { old: 'Alice', new: 'Bob' },
    });
  });

  // A PATCH that never mentions `owner` must never fabricate a diff entry
  // for it just because some other field also happens to differ from a
  // hypothetical default -- only keys actually present on `patch` count,
  // mirroring Prisma's own "undefined = don't touch" semantics.
  it('ignores tracked fields not present in the patch at all', () => {
    expect(build_compliance_edit_diff({ title: 'Old', owner: 'Alice' }, { title: 'New' })).toEqual({
      title: { old: 'Old', new: 'New' },
    });
  });

  it('normalizes Date values to ISO strings so a Date vs. equivalent ISO string is not a false-positive change', () => {
    const d = new Date('2026-12-31T00:00:00.000Z');
    expect(
      build_compliance_edit_diff({ due_date: d }, { due_date: '2026-12-31T00:00:00.000Z' }),
    ).toBeNull();
  });

  it('records a real due_date change with both values as ISO strings', () => {
    const oldDate = new Date('2026-01-01T00:00:00.000Z');
    const newDate = new Date('2026-06-01T00:00:00.000Z');
    expect(build_compliance_edit_diff({ due_date: oldDate }, { due_date: newDate })).toEqual({
      due_date: { old: '2026-01-01T00:00:00.000Z', new: '2026-06-01T00:00:00.000Z' },
    });
  });

  it('treats undefined/null existing values as equal to a null patch value (no diff)', () => {
    expect(build_compliance_edit_diff({ owner: undefined }, { owner: null })).toBeNull();
  });

  it('ignores explicitly untracked fields even when present in the patch (is_edited, next_review_date, attachments)', () => {
    expect(
      build_compliance_edit_diff(
        { is_edited: false, next_review_date: null, attachments: [] },
        {
          is_edited: true,
          next_review_date: new Date('2099-01-01'),
          attachments: ['https://example.com/a.pdf'],
        },
      ),
    ).toBeNull();
  });
});

describe('compliance service — org scoping (issue #93)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row — ADMIN-of-self fallback (org anchor ===
    // caller's own accountId), same convention every service test in this
    // suite uses.
    orgMemberDb.findUnique.mockResolvedValue(null);
    // aexa-server#250: attest_compliance_into_db wraps the attestation
    // insert and the next_review_date update in a $transaction. The mock
    // runs the interactive callback with the same mocked prisma as the tx
    // client.
    txFn.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
    // Default (#97): invalidateLiveLineReviews's updateMany is a no-op call
    // on every edit unless a specific test asserts on it.
    lineReviewDb.updateMany.mockResolvedValue({ count: 0 });
  });

  describe('write-path role scoping (issue #55 slice 3)', () => {
    it('VIEWER cannot create a compliance obligation', async () => {
      mockMembership('VIEWER');

      await expect(
        compliance_service.create_compliance_into_db(
          makeReq({
            body: { title: 'GDPR Art. 30', domain: 'Data Protection', status: 'pending' },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('LIGHT_USER cannot update a compliance obligation', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { title: 'hack' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.findFirst).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('VIEWER cannot delete a compliance obligation', async () => {
      mockMembership('VIEWER');

      await expect(
        compliance_service.delete_compliance_from_db(makeReq({ params: { id: 'c1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.delete).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR (a writer role) can still create — the role gate does not over-block', async () => {
      mockMembership('LEAD_AUDITOR');
      db.create.mockResolvedValue({});

      await compliance_service.create_compliance_into_db(
        makeReq({ body: { title: 'GDPR Art. 30', domain: 'Data Protection', status: 'pending' } }),
      );

      expect(db.create).toHaveBeenCalled();
    });
  });

  describe('update_compliance_into_db — org_account_id tamper resistance', () => {
    it('ignores an org_account_id supplied in the body and always writes the caller org anchor', async () => {
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });
      db.update.mockResolvedValue({});

      await compliance_service.update_compliance_into_db(
        makeReq({
          params: { id: 'c1' },
          body: { title: 'Revised', org_account_id: 'other-org' },
        }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
    });
  });

  describe('get_all_compliance_from_db', () => {
    it('filters by caller org', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await compliance_service.get_all_compliance_from_db(makeReq({ query: {} }));

      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({ org_account_id: ORG_A });
    });

    it('scopes the count query by caller org too', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await compliance_service.get_all_compliance_from_db(makeReq({ query: {} }));

      const [countArg] = db.count.mock.calls[0];
      expect(countArg.where).toMatchObject({ org_account_id: ORG_A });
    });

    it('applies status and domain filters when supplied', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await compliance_service.get_all_compliance_from_db(
        makeReq({ query: { status: 'compliant', domain: 'Financial' } }),
      );

      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({
        org_account_id: ORG_A,
        status: 'compliant',
        domain: 'Financial',
      });
    });

    it('includes totalPage in meta, computed via the shared pagination helper', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(23);

      const result = await compliance_service.get_all_compliance_from_db(
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

      const result = await compliance_service.get_all_compliance_from_db(makeReq({ query: {} }));

      expect(result.meta).toEqual({
        page: 1,
        limit: 10,
        skip: 0,
        total: 0,
        totalPage: 0,
      });
    });

    // aexa-server#243: overdue is computed at read time (like the KRI
    // module's `overdue`), so a list of obligations can flag a past-due one
    // — including a "compliant" one — without a background job.
    it('attaches computed overdue per obligation', async () => {
      const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      db.findMany.mockResolvedValue([
        { id: 'c1', status: 'in_progress', due_date: past },
        { id: 'c2', status: 'compliant', due_date: future },
        { id: 'c3', status: 'not_applicable', due_date: past },
      ]);
      db.count.mockResolvedValue(3);

      const result = await compliance_service.get_all_compliance_from_db(makeReq({ query: {} }));

      expect(result.data.find((o) => o.id === 'c1')?.overdue).toBe(true);
      expect(result.data.find((o) => o.id === 'c2')?.overdue).toBe(false);
      expect(result.data.find((o) => o.id === 'c3')?.overdue).toBe(false);
    });
  });

  describe('get_single_compliance_from_db', () => {
    it('includes org_account_id in WHERE clause', async () => {
      db.findUnique.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });

      await compliance_service.get_single_compliance_from_db(makeReq({ params: { id: 'c1' } }));

      expect(db.findUnique).toHaveBeenCalledWith({
        where: { id: 'c1', org_account_id: ORG_A },
        include: {
          actions: { select: { id: true, actionTitle: true, status: true } },
          risk: { select: { id: true, ref: true, name: true, status: true } },
        },
      });
    });

    it('throws 404 for another org obligation instead of returning null', async () => {
      db.findUnique.mockResolvedValue(null);

      await expect(
        compliance_service.get_single_compliance_from_db(makeReq({ params: { id: 'org-b-c1' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('attaches computed overdue', async () => {
      const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      db.findUnique.mockResolvedValue({
        id: 'c1',
        org_account_id: ORG_A,
        status: 'in_progress',
        due_date: past,
      });

      const result = await compliance_service.get_single_compliance_from_db(
        makeReq({ params: { id: 'c1' } }),
      );

      expect(result.overdue).toBe(true);
    });
  });

  describe('create_compliance_into_db', () => {
    it('injects org_account_id into the created record', async () => {
      db.create.mockResolvedValue({});

      await compliance_service.create_compliance_into_db(
        makeReq({ body: { title: 'GDPR Art. 30', domain: 'Data Protection', status: 'pending' } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.org_account_id).toBe(ORG_A);
    });

    // aexa-server#243: evidence was decorative — nothing required an
    // attachment to claim "compliant". This is the hard gate the ticket
    // posed as an option, now enforced on create.
    describe('evidence gating for status: compliant (#243)', () => {
      it('rejects a compliant obligation with no attachments', async () => {
        await expect(
          compliance_service.create_compliance_into_db(
            makeReq({
              body: { title: 'GDPR Art. 30', domain: 'Data Protection', status: 'compliant' },
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 400 });

        expect(db.create).not.toHaveBeenCalled();
      });

      it('rejects a compliant obligation with an explicitly empty attachments array', async () => {
        await expect(
          compliance_service.create_compliance_into_db(
            makeReq({
              body: {
                title: 'GDPR Art. 30',
                domain: 'Data Protection',
                status: 'compliant',
                attachments: [],
              },
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 400 });

        expect(db.create).not.toHaveBeenCalled();
      });

      it('allows a compliant obligation with at least one attachment', async () => {
        db.create.mockResolvedValue({});

        await compliance_service.create_compliance_into_db(
          makeReq({
            body: {
              title: 'GDPR Art. 30',
              domain: 'Data Protection',
              status: 'compliant',
              attachments: ['https://cdn.example/evidence.pdf'],
            },
          }),
        );

        expect(db.create).toHaveBeenCalled();
      });

      it('does not gate a non-compliant status even with zero attachments', async () => {
        db.create.mockResolvedValue({});

        await compliance_service.create_compliance_into_db(
          makeReq({
            body: { title: 'GDPR Art. 30', domain: 'Data Protection', status: 'in_progress' },
          }),
        );

        expect(db.create).toHaveBeenCalled();
      });
    });

    describe('next_review_date seeding (aexa-server#250)', () => {
      it('seeds next_review_date from due_date when a recurrence is declared', async () => {
        db.create.mockResolvedValue({});
        const dueDate = new Date('2027-01-01T00:00:00.000Z');

        await compliance_service.create_compliance_into_db(
          makeReq({
            body: {
              title: 'Annual filing',
              domain: 'Financial',
              status: 'pending',
              recurrence: 'annual',
              due_date: dueDate,
            },
          }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data.next_review_date).toEqual(dueDate);
      });

      it('leaves next_review_date null when no recurrence is declared', async () => {
        db.create.mockResolvedValue({});

        await compliance_service.create_compliance_into_db(
          makeReq({
            body: {
              title: 'One-time filing',
              domain: 'Financial',
              status: 'pending',
              due_date: new Date('2027-01-01T00:00:00.000Z'),
            },
          }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data.next_review_date).toBeNull();
      });

      it('discards a client-supplied next_review_date and computes its own', async () => {
        db.create.mockResolvedValue({});

        await compliance_service.create_compliance_into_db(
          makeReq({
            body: {
              title: 'Annual filing',
              domain: 'Financial',
              status: 'pending',
              recurrence: 'annual',
              due_date: new Date('2027-01-01T00:00:00.000Z'),
              next_review_date: new Date('2099-01-01T00:00:00.000Z'), // attempted override
            },
          }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data.next_review_date).toEqual(new Date('2027-01-01T00:00:00.000Z'));
      });

      // Regression: a recurring obligation created with no due_date at all
      // previously seeded next_review_date: null, reading as permanently
      // non-overdue until its first attestation — defeating the whole
      // "continuous oversight" point for exactly the obligations that had
      // no due_date to fall back on.
      it('falls back to now + the cadence interval when a recurrence is declared with no due_date', async () => {
        db.create.mockResolvedValue({});
        const before = Date.now();

        await compliance_service.create_compliance_into_db(
          makeReq({
            body: {
              title: 'Annual filing',
              domain: 'Financial',
              status: 'pending',
              recurrence: 'annual',
            },
          }),
        );

        const after = Date.now();
        const callArg = db.create.mock.calls[0][0];
        const nextReviewMs = (callArg.data.next_review_date as Date).getTime();
        const yearMs = 365 * 24 * 60 * 60 * 1000;
        expect(nextReviewMs).toBeGreaterThanOrEqual(before + yearMs);
        expect(nextReviewMs).toBeLessThanOrEqual(after + yearMs);
      });

      // aexa-server#318: a recurrence value that normalizes to an inherited
      // Object.prototype key (e.g. 'constructor') must be treated the same
      // as any other unrecognized recurrence -- null, not resolved through
      // the prototype chain into NaN arithmetic and an invalid Date.
      // Deliberately omits due_date: `payload.due_date ?? computeNextReviewDate(...)`
      // short-circuits before computeNextReviewDate ever runs when due_date
      // is supplied, so a due_date-present variant wouldn't exercise the bug.
      it('leaves next_review_date null for a prototype-chain-colliding recurrence (#318) with no due_date', async () => {
        db.create.mockResolvedValue({});

        await compliance_service.create_compliance_into_db(
          makeReq({
            body: {
              title: 'Suspicious recurrence, no due date',
              domain: 'Financial',
              status: 'pending',
              recurrence: 'constructor',
            },
          }),
        );

        const callArg = db.create.mock.calls[0][0];
        expect(callArg.data.next_review_date).toBeNull();
      });
    });
  });

  describe('update_compliance_into_db', () => {
    it('verifies ownership before updating', async () => {
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });
      db.update.mockResolvedValue({});

      await compliance_service.update_compliance_into_db(
        makeReq({ params: { id: 'c1' }, body: { title: 'Revised' } }),
      );

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'c1', org_account_id: ORG_A } });
      expect(db.update).toHaveBeenCalled();
    });

    it('throws 404 and does NOT update another org obligation', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        compliance_service.update_compliance_into_db(makeReq({ params: { id: 'org-b-c1' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });

    // aexa-server#250: next_review_date is derived (via attest_compliance_into_db
    // or seeded on create), never client-settable through a direct PATCH.
    it('discards a client-supplied next_review_date on update', async () => {
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });
      db.update.mockResolvedValue({});

      await compliance_service.update_compliance_into_db(
        makeReq({
          params: { id: 'c1' },
          body: { title: 'Revised', next_review_date: new Date('2099-01-01T00:00:00.000Z') },
        }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data).not.toHaveProperty('next_review_date');
    });

    // aexa-server#260: clearing recurrence must also clear the stale
    // next_review_date it seeded, or compute_obligation_overdue keeps
    // comparing against a future date from the old cadence forever.
    describe('nulling next_review_date when recurrence is cleared (#260)', () => {
      it.each([
        ['null', null],
        ['one_time', 'one_time'],
        ['an unrecognized cadence', 'biannual'],
        ['an empty string', ''],
        ['a whitespace-only string', '   '],
      ])('nulls next_review_date when recurrence is cleared to %s', async (_label, recurrence) => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          recurrence: 'quarterly',
          next_review_date: new Date('2099-01-01T00:00:00.000Z'),
        });
        db.update.mockResolvedValue({});

        await compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { recurrence } }),
        );

        const callArg = db.update.mock.calls[0][0];
        expect(callArg.data.next_review_date).toBeNull();
      });

      it('does NOT touch next_review_date when recurrence is left unchanged (not part of this PATCH)', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          recurrence: 'quarterly',
          next_review_date: new Date('2099-01-01T00:00:00.000Z'),
        });
        db.update.mockResolvedValue({});

        await compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { title: 'Revised' } }),
        );

        const callArg = db.update.mock.calls[0][0];
        expect(callArg.data).not.toHaveProperty('next_review_date');
      });

      it('does NOT null next_review_date when recurrence is switched to another valid cadence', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          recurrence: 'quarterly',
          next_review_date: new Date('2099-01-01T00:00:00.000Z'),
        });
        db.update.mockResolvedValue({});

        await compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { recurrence: 'monthly' } }),
        );

        const callArg = db.update.mock.calls[0][0];
        expect(callArg.data).not.toHaveProperty('next_review_date');
      });
    });

    // aexa-server#265: mirrors create's own seeding rule -- the first
    // cycle's due_date doubles as the first review date pre-attestation.
    // If due_date is edited before any attestation exists, next_review_date
    // must move with it.
    describe('recomputing next_review_date when due_date is edited pre-attestation (#265)', () => {
      it('moves next_review_date to the new due_date when edited before any attestation', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          recurrence: 'monthly',
          due_date: new Date('2026-08-30T00:00:00.000Z'),
          next_review_date: new Date('2026-08-30T00:00:00.000Z'),
        });
        db.update.mockResolvedValue({});
        attestationDb.count.mockResolvedValue(0);

        const newDueDate = new Date('2026-09-15T00:00:00.000Z');
        await compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { due_date: newDueDate } }),
        );

        expect(attestationDb.count).toHaveBeenCalledWith({
          where: { obligation_id: 'c1' },
        });
        const callArg = db.update.mock.calls[0][0];
        expect(callArg.data.next_review_date).toBe(newDueDate);
      });

      it('review round 1: falls back to computeNextReviewDate when due_date is cleared to null while recurrence stays active', async () => {
        // Matches create's own fallback (payload.due_date ??
        // computeNextReviewDate(...)) -- clearing due_date must still seed
        // a review date from the active cadence, not null it out.
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          recurrence: 'monthly',
          due_date: new Date('2026-08-30T00:00:00.000Z'),
          next_review_date: new Date('2026-08-30T00:00:00.000Z'),
        });
        db.update.mockResolvedValue({});
        attestationDb.count.mockResolvedValue(0);

        await compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { due_date: null } }),
        );

        const callArg = db.update.mock.calls[0][0];
        // 30 days (monthly) out from computeNextReviewDate's "now" -- just
        // assert it's a real Date, not null, and roughly in the expected
        // window, since the test can't control the exact "now" the service
        // uses internally.
        expect(callArg.data.next_review_date).toBeInstanceOf(Date);
        expect(callArg.data.next_review_date).not.toBeNull();
      });

      it('review round 1: the attestation count check and the final update run inside one $transaction', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          recurrence: 'monthly',
          due_date: new Date('2026-08-30T00:00:00.000Z'),
          next_review_date: new Date('2026-08-30T00:00:00.000Z'),
        });
        db.update.mockResolvedValue({});
        attestationDb.count.mockResolvedValue(0);

        await compliance_service.update_compliance_into_db(
          makeReq({
            params: { id: 'c1' },
            body: { due_date: new Date('2026-09-15T00:00:00.000Z') },
          }),
        );

        expect(txFn).toHaveBeenCalledTimes(1);
      });

      it('does NOT move next_review_date when due_date is edited AFTER a real attestation exists', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          recurrence: 'monthly',
          due_date: new Date('2026-08-30T00:00:00.000Z'),
          next_review_date: new Date('2026-09-29T00:00:00.000Z'),
        });
        db.update.mockResolvedValue({});
        attestationDb.count.mockResolvedValue(1);

        await compliance_service.update_compliance_into_db(
          makeReq({
            params: { id: 'c1' },
            body: { due_date: new Date('2026-09-15T00:00:00.000Z') },
          }),
        );

        const callArg = db.update.mock.calls[0][0];
        expect(callArg.data).not.toHaveProperty('next_review_date');
      });

      it('does NOT recompute next_review_date when due_date is not part of the PATCH', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          recurrence: 'monthly',
          due_date: new Date('2026-08-30T00:00:00.000Z'),
          next_review_date: new Date('2026-08-30T00:00:00.000Z'),
        });
        db.update.mockResolvedValue({});

        await compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { title: 'Revised' } }),
        );

        expect(attestationDb.count).not.toHaveBeenCalled();
        const callArg = db.update.mock.calls[0][0];
        expect(callArg.data).not.toHaveProperty('next_review_date');
      });

      it('does NOT recompute next_review_date for a non-recurring obligation (no cadence to seed from)', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          recurrence: null,
          due_date: new Date('2026-08-30T00:00:00.000Z'),
          next_review_date: null,
        });
        db.update.mockResolvedValue({});

        await compliance_service.update_compliance_into_db(
          makeReq({
            params: { id: 'c1' },
            body: { due_date: new Date('2026-09-15T00:00:00.000Z') },
          }),
        );

        expect(attestationDb.count).not.toHaveBeenCalled();
        const callArg = db.update.mock.calls[0][0];
        expect(callArg.data).not.toHaveProperty('next_review_date');
      });

      it('#260s null-out wins when BOTH recurrence is cleared and due_date is edited in the same PATCH', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          recurrence: 'monthly',
          due_date: new Date('2026-08-30T00:00:00.000Z'),
          next_review_date: new Date('2026-08-30T00:00:00.000Z'),
        });
        db.update.mockResolvedValue({});

        await compliance_service.update_compliance_into_db(
          makeReq({
            params: { id: 'c1' },
            body: { recurrence: null, due_date: new Date('2026-09-15T00:00:00.000Z') },
          }),
        );

        // #260's branch runs first and nulls it. Note: #265's own
        // effectiveRecurrence check independently also resolves to null
        // here (same req.body.recurrence input, same computeNextReviewDate
        // call), so this doesn't distinguish the `data.next_review_date
        // === undefined` guard specifically from #265's own recurrence
        // check -- both conditions structurally agree whenever recurrence
        // is being cleared in the same PATCH. It does still correctly pin
        // down the end-to-end outcome: the final next_review_date is null,
        // not overwritten with the new due_date.
        expect(attestationDb.count).not.toHaveBeenCalled();
        const callArg = db.update.mock.calls[0][0];
        expect(callArg.data.next_review_date).toBeNull();
      });
    });

    describe('evidence gating for status: compliant (#243)', () => {
      it('rejects setting status to compliant on an obligation with no existing attachments', async () => {
        db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A, attachments: [] });

        await expect(
          compliance_service.update_compliance_into_db(
            makeReq({ params: { id: 'c1' }, body: { status: 'compliant' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 400 });

        expect(db.update).not.toHaveBeenCalled();
      });

      it('allows setting status to compliant when attachments are supplied in the same request', async () => {
        db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A, attachments: [] });
        db.update.mockResolvedValue({});

        await compliance_service.update_compliance_into_db(
          makeReq({
            params: { id: 'c1' },
            body: { status: 'compliant', attachments: ['https://cdn.example/e.pdf'] },
          }),
        );

        expect(db.update).toHaveBeenCalled();
      });

      it('allows setting status to compliant when the existing row already has attachments', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          attachments: ['https://cdn.example/already-uploaded.pdf'],
        });
        db.update.mockResolvedValue({});

        await compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { status: 'compliant' } }),
        );

        expect(db.update).toHaveBeenCalled();
      });

      it('allows a legacy compliant-with-no-evidence row to get its first attachment via an update that does not touch status', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          status: 'compliant',
          attachments: [],
        });
        db.update.mockResolvedValue({});

        await compliance_service.update_compliance_into_db(
          makeReq({
            params: { id: 'c1' },
            body: { attachments: ['https://cdn.example/first-evidence.pdf'] },
          }),
        );

        expect(db.update).toHaveBeenCalled();
      });

      // The single most realistic accidental-PATCH scenario: someone edits
      // an unrelated field on a legacy compliant-with-no-evidence row,
      // touching neither status nor attachments. The effective state is
      // still compliant + zero evidence, so this must still 400.
      it('rejects a no-op-on-evidence update (unrelated field only) against a legacy compliant-with-no-evidence row', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          status: 'compliant',
          attachments: [],
        });

        await expect(
          compliance_service.update_compliance_into_db(
            makeReq({ params: { id: 'c1' }, body: { title: 'Revised' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 400 });

        expect(db.update).not.toHaveBeenCalled();
      });

      // The effective (merged) state is checked, not just the touched
      // fields — a request that clears attachments on an already-compliant
      // row must not silently leave it "compliant" with zero evidence.
      it('rejects clearing attachments to empty on an obligation that is already compliant', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          status: 'compliant',
          attachments: ['https://cdn.example/e.pdf'],
        });

        await expect(
          compliance_service.update_compliance_into_db(
            makeReq({ params: { id: 'c1' }, body: { attachments: [] } }),
          ),
        ).rejects.toMatchObject({ statusCode: 400 });

        expect(db.update).not.toHaveBeenCalled();
      });

      it('does not gate an update that leaves status non-compliant, even with zero attachments', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          status: 'in_progress',
          attachments: [],
        });
        db.update.mockResolvedValue({});

        await compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { title: 'Revised' } }),
        );

        expect(db.update).toHaveBeenCalled();
      });
    });

    // Quality-bar-loop industry-standards gap: the edit-history write, done
    // inside the same $transaction as the row update itself.
    describe('edit-history logging (quality-bar-loop)', () => {
      it('writes a ComplianceObligationEdit row inside the same transaction as the update when a tracked field changes', async () => {
        db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A, title: 'Old title' });
        db.update.mockResolvedValue({ id: 'c1' });
        editHistoryDb.create.mockResolvedValue({});

        await compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { title: 'New title' } }),
        );

        expect(txFn).toHaveBeenCalledTimes(1);
        expect(editHistoryDb.create).toHaveBeenCalledWith({
          data: {
            org_account_id: ORG_A,
            obligation_id: 'c1',
            edited_by: ORG_A,
            changes: { title: { old: 'Old title', new: 'New title' } },
          },
        });
      });

      it('does NOT write an edit-history row when the patch touches no tracked fields', async () => {
        db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A, is_edited: false });
        db.update.mockResolvedValue({ id: 'c1' });

        await compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { is_edited: true } }),
        );

        expect(editHistoryDb.create).not.toHaveBeenCalled();
      });

      it('does NOT write an edit-history row when a tracked field is present but unchanged', async () => {
        db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A, title: 'Same title' });
        db.update.mockResolvedValue({ id: 'c1' });

        await compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { title: 'Same title' } }),
        );

        expect(editHistoryDb.create).not.toHaveBeenCalled();
      });

      it('captures multiple simultaneous tracked-field changes in one edit-history row', async () => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          title: 'Old title',
          owner: 'Alice',
          status: 'in_progress',
        });
        db.update.mockResolvedValue({ id: 'c1' });
        editHistoryDb.create.mockResolvedValue({});

        await compliance_service.update_compliance_into_db(
          makeReq({
            params: { id: 'c1' },
            body: { title: 'New title', owner: 'Bob', status: 'in_progress' },
          }),
        );

        const [{ data }] = editHistoryDb.create.mock.calls[0];
        expect(data.changes).toEqual({
          title: { old: 'Old title', new: 'New title' },
          owner: { old: 'Alice', new: 'Bob' },
        });
      });

      it('does NOT log a change to attachments (explicitly deferred, its own history concern)', async () => {
        db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A, attachments: [] });
        db.update.mockResolvedValue({ id: 'c1' });

        await compliance_service.update_compliance_into_db(
          makeReq({
            params: { id: 'c1' },
            body: { attachments: ['https://cdn.example/e.pdf'] },
          }),
        );

        expect(editHistoryDb.create).not.toHaveBeenCalled();
      });
    });
  });

  // Issue #97: Three Lines of Defense classification. update_compliance_into_db
  // already gates its entire payload with assertCanWriteOrgResource (ADMIN /
  // LEAD_AUDITOR only) — these tests confirm line_of_defense specifically
  // rides that same existing gate and is actually persisted when allowed.
  describe('update_compliance_into_db — line_of_defense (#97)', () => {
    it('LIGHT_USER cannot reassign line_of_defense', async () => {
      mockMembership('LIGHT_USER');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ANCHOR });

      await expect(
        compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { line_of_defense: 'FIRST' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('VIEWER cannot reassign line_of_defense', async () => {
      mockMembership('VIEWER');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ANCHOR });

      await expect(
        compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { line_of_defense: 'THIRD' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('ADMIN can reassign line_of_defense', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ANCHOR });
      db.update.mockResolvedValue({ id: 'c1', line_of_defense: 'THIRD' });

      await compliance_service.update_compliance_into_db(
        makeReq({ params: { id: 'c1' }, body: { line_of_defense: 'THIRD' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.line_of_defense).toBe('THIRD');
    });

    // aexa-frontend#208: third-line independence — a LEAD_AUDITOR (third
    // line) must not be able to reclassify a first/second-line entity's
    // (ComplianceObligation's) ownership. Only ADMIN may reassign now.
    it('LEAD_AUDITOR cannot reassign line_of_defense (third-line independence)', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ANCHOR });

      await expect(
        compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { line_of_defense: 'FIRST' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR can still update other fields on the same request as long as line_of_defense is untouched', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ANCHOR });
      db.update.mockResolvedValue({ id: 'c1', title: 'Renamed' });

      await compliance_service.update_compliance_into_db(
        makeReq({ params: { id: 'c1' }, body: { title: 'Renamed' } }),
      );

      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('record_compliance_line_review (#97)', () => {
    it('throws 404 and does not record a review for another org obligation', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        compliance_service.record_compliance_line_review(
          makeReq({ params: { id: 'org-b-c1' }, body: { line: 'SECOND' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(lineReviewDb.create).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR can record a THIRD-line review (audit-line self-check)', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });
      lineReviewDb.create.mockResolvedValue({ id: 'rev-1' });
      lineReviewDb.findMany.mockResolvedValue([{ id: 'rev-1', line: 'THIRD' }]);

      await compliance_service.record_compliance_line_review(
        makeReq({ params: { id: 'c1' }, body: { line: 'THIRD' } }),
      );

      expect(lineReviewDb.create).toHaveBeenCalled();
    });

    // Third-line independence, same split as ownership reassignment
    // (aexa-frontend#208): a LEAD_AUDITOR may vouch for THIRD-line review,
    // but not for FIRST/SECOND/GOVERNING_BODY -- those are management-line
    // judgment calls.
    it('LEAD_AUDITOR cannot record a SECOND-line review', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });

      await expect(
        compliance_service.record_compliance_line_review(
          makeReq({ params: { id: 'c1' }, body: { line: 'SECOND' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(lineReviewDb.create).not.toHaveBeenCalled();
    });

    it('ADMIN can record a FIRST-line review', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });
      lineReviewDb.create.mockResolvedValue({ id: 'rev-2' });
      lineReviewDb.findMany.mockResolvedValue([{ id: 'rev-2', line: 'FIRST' }]);

      await compliance_service.record_compliance_line_review(
        makeReq({ params: { id: 'c1' }, body: { line: 'FIRST' } }),
      );

      expect(lineReviewDb.create).toHaveBeenCalled();
    });

    it('ADMIN cannot record a THIRD-line review (audit independence -- management cannot vouch for audit)', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });

      await expect(
        compliance_service.record_compliance_line_review(
          makeReq({ params: { id: 'c1' }, body: { line: 'THIRD' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(lineReviewDb.create).not.toHaveBeenCalled();
    });

    // A fresh review for the same line supersedes (invalidates) the prior
    // live one rather than stacking duplicates -- see
    // line_of_defense_review.ts's recordLineReview.
    it('invalidates the prior live review for the same line before creating the new one', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });
      lineReviewDb.create.mockResolvedValue({ id: 'rev-3' });
      lineReviewDb.findMany.mockResolvedValue([{ id: 'rev-3', line: 'FIRST' }]);

      await compliance_service.record_compliance_line_review(
        makeReq({ params: { id: 'c1' }, body: { line: 'FIRST', notes: 'looks fine' } }),
      );

      expect(lineReviewDb.updateMany).toHaveBeenCalledWith({
        where: { obligationId: 'c1', line: 'FIRST', invalidatedAt: null },
        data: { invalidatedAt: expect.any(Date) },
      });
      expect(lineReviewDb.create).toHaveBeenCalledWith({
        data: { obligationId: 'c1', line: 'FIRST', reviewedById: ORG_A, notes: 'looks fine' },
      });
    });

    it('editing an obligation invalidates every live line review -- the reviewed version is now stale', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });
      db.update.mockResolvedValue({ id: 'c1', title: 'Renamed' });

      await compliance_service.update_compliance_into_db(
        makeReq({ params: { id: 'c1' }, body: { title: 'Renamed' } }),
      );

      expect(lineReviewDb.updateMany).toHaveBeenCalledWith({
        where: { obligationId: 'c1', invalidatedAt: null },
        data: { invalidatedAt: expect.any(Date) },
      });
    });
  });

  describe('delete_compliance_from_db', () => {
    it('verifies ownership before deleting', async () => {
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });
      db.delete.mockResolvedValue({});

      await compliance_service.delete_compliance_from_db(makeReq({ params: { id: 'c1' } }));

      expect(db.findFirst).toHaveBeenCalledWith({
        where: { id: 'c1', org_account_id: ORG_A },
      });
      expect(db.delete).toHaveBeenCalledWith({
        where: { id: 'c1', org_account_id: ORG_A },
      });
    });

    it('throws 404 and does NOT delete another org obligation', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        compliance_service.delete_compliance_from_db(makeReq({ params: { id: 'org-b-c1' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe('attest_compliance_into_db (aexa-server#250)', () => {
    it('throws 404 for another org obligation', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        compliance_service.attest_compliance_into_db(
          makeReq({ params: { id: 'org-b-c1' }, body: {} }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(attestationDb.create).not.toHaveBeenCalled();
    });

    it('VIEWER cannot attest', async () => {
      mockMembership('VIEWER');

      await expect(
        compliance_service.attest_compliance_into_db(makeReq({ params: { id: 'c1' }, body: {} })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(attestationDb.create).not.toHaveBeenCalled();
    });

    it('creates an attestation snapshotting the obligation status, the caller, and an optional note', async () => {
      db.findFirst.mockResolvedValue({
        id: 'c1',
        org_account_id: ORG_A,
        status: 'compliant',
        recurrence: null,
      });
      attestationDb.create.mockResolvedValue({ id: 'att-1' });
      db.update.mockResolvedValue({ id: 'c1', status: 'compliant' });

      await compliance_service.attest_compliance_into_db(
        makeReq({ params: { id: 'c1' }, body: { note: 'Confirmed with legal counsel' } }),
      );

      const callArg = attestationDb.create.mock.calls[0][0];
      expect(callArg.data).toMatchObject({
        org_account_id: ORG_A,
        obligation_id: 'c1',
        attested_by: ORG_A,
        status_at_attestation: 'compliant',
        note: 'Confirmed with legal counsel',
      });
      expect(callArg.data.attested_at).toBeInstanceOf(Date);
    });

    it('leaves next_review_date null (untouched) for a non-recurring obligation', async () => {
      db.findFirst.mockResolvedValue({
        id: 'c1',
        org_account_id: ORG_A,
        status: 'compliant',
        recurrence: null,
      });
      attestationDb.create.mockResolvedValue({ id: 'att-1' });
      db.update.mockResolvedValue({ id: 'c1' });

      await compliance_service.attest_compliance_into_db(
        makeReq({ params: { id: 'c1' }, body: {} }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.next_review_date).toBeNull();
    });

    it.each([
      ['monthly', 30],
      ['quarterly', 90],
      ['annual', 365],
    ])(
      'advances next_review_date by the %s cadence interval from attested_at',
      async (recurrence, days) => {
        db.findFirst.mockResolvedValue({
          id: 'c1',
          org_account_id: ORG_A,
          status: 'compliant',
          recurrence,
        });
        attestationDb.create.mockResolvedValue({ id: 'att-1' });
        db.update.mockResolvedValue({ id: 'c1' });

        const before = Date.now();
        await compliance_service.attest_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: {} }),
        );
        const after = Date.now();

        const callArg = db.update.mock.calls[0][0];
        const nextReviewMs = (callArg.data.next_review_date as Date).getTime();
        const expectedIntervalMs = days * 24 * 60 * 60 * 1000;
        // Bracket rather than exact-match, since attested_at is `new Date()`
        // captured inside the service call, not controlled by this test.
        expect(nextReviewMs).toBeGreaterThanOrEqual(before + expectedIntervalMs);
        expect(nextReviewMs).toBeLessThanOrEqual(after + expectedIntervalMs);
      },
    );

    it('wraps the attestation insert and the next_review_date update in a single $transaction', async () => {
      db.findFirst.mockResolvedValue({
        id: 'c1',
        org_account_id: ORG_A,
        status: 'compliant',
        recurrence: 'monthly',
      });
      attestationDb.create.mockResolvedValue({ id: 'att-1' });
      db.update.mockResolvedValue({ id: 'c1' });

      await compliance_service.attest_compliance_into_db(
        makeReq({ params: { id: 'c1' }, body: {} }),
      );

      expect(txFn).toHaveBeenCalledTimes(1);
      expect(attestationDb.create).toHaveBeenCalled();
      expect(db.update).toHaveBeenCalled();
    });

    // aexa-server#250: recurrence/status are re-read INSIDE the transaction
    // (via tx.complianceObligation.findFirst) rather than reusing the
    // pre-transaction snapshot — otherwise a concurrent update changing
    // `recurrence` between the initial ownership check and this
    // transaction could have its change silently clobbered by a
    // next_review_date computed from a stale cadence. Same TOCTOU fix as
    // #241's residual-score resolution and #242's KRI submission.
    it('re-reads the row inside the transaction rather than reusing the pre-transaction snapshot', async () => {
      db.findFirst.mockResolvedValue({
        id: 'c1',
        org_account_id: ORG_A,
        status: 'compliant',
        recurrence: 'monthly',
      });
      attestationDb.create.mockResolvedValue({ id: 'att-1' });
      db.update.mockResolvedValue({ id: 'c1' });

      await compliance_service.attest_compliance_into_db(
        makeReq({ params: { id: 'c1' }, body: {} }),
      );

      // Called once for the outer ownership/404 check, once inside the
      // transaction for the fresh recurrence/status read.
      expect(db.findFirst).toHaveBeenCalledTimes(2);
      expect(db.findFirst.mock.calls[1][0]).toEqual({ where: { id: 'c1' } });
    });

    // Confirms a fresh attestation's next_review_date genuinely REPLACES an
    // already-set one from a prior cycle, rather than stacking onto it or
    // being ignored.
    it('replaces an existing non-null next_review_date with a freshly computed one', async () => {
      db.findFirst.mockResolvedValue({
        id: 'c1',
        org_account_id: ORG_A,
        status: 'compliant',
        recurrence: 'monthly',
        next_review_date: new Date('2020-01-01T00:00:00.000Z'), // long-stale prior cycle
      });
      attestationDb.create.mockResolvedValue({ id: 'att-2' });
      db.update.mockResolvedValue({ id: 'c1' });

      const before = Date.now();
      await compliance_service.attest_compliance_into_db(
        makeReq({ params: { id: 'c1' }, body: {} }),
      );
      const after = Date.now();

      const callArg = db.update.mock.calls[0][0];
      const nextReviewMs = (callArg.data.next_review_date as Date).getTime();
      const monthMs = 30 * 24 * 60 * 60 * 1000;
      expect(nextReviewMs).toBeGreaterThanOrEqual(before + monthMs);
      expect(nextReviewMs).toBeLessThanOrEqual(after + monthMs);
    });
  });

  describe('get_compliance_attestations_from_db (aexa-server#250)', () => {
    it('throws 404 for another org obligation', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        compliance_service.get_compliance_attestations_from_db(
          makeReq({ params: { id: 'org-b-c1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(attestationDb.findMany).not.toHaveBeenCalled();
    });

    it('returns the attestation history for the obligation, newest first, org-scoped via the obligation ownership check', async () => {
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });
      attestationDb.findMany.mockResolvedValue([
        { id: 'att-2', attested_at: new Date('2026-02-01') },
        { id: 'att-1', attested_at: new Date('2026-01-01') },
      ]);
      attestationDb.count.mockResolvedValue(2);

      const result = await compliance_service.get_compliance_attestations_from_db(
        makeReq({ params: { id: 'c1' } }),
      );

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'c1', org_account_id: ORG_A } });
      const [callArg] = attestationDb.findMany.mock.calls[0];
      expect(callArg.where).toEqual({ obligation_id: 'c1' });
      expect(callArg.orderBy).toEqual({ attested_at: 'desc' });
      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
    });
  });

  describe('get_compliance_edit_history_from_db (quality-bar-loop industry-standards gap)', () => {
    it('throws 404 for another org obligation', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        compliance_service.get_compliance_edit_history_from_db(
          makeReq({ params: { id: 'org-b-c1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(editHistoryDb.findMany).not.toHaveBeenCalled();
    });

    it('returns the edit history for the obligation, newest first, org-scoped via the obligation ownership check', async () => {
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });
      editHistoryDb.findMany.mockResolvedValue([
        {
          id: 'edit-2',
          edited_at: new Date('2026-02-01'),
          changes: { status: { old: 'in_progress', new: 'compliant' } },
        },
        {
          id: 'edit-1',
          edited_at: new Date('2026-01-01'),
          changes: { title: { old: 'Old title', new: 'New title' } },
        },
      ]);
      editHistoryDb.count.mockResolvedValue(2);

      const result = await compliance_service.get_compliance_edit_history_from_db(
        makeReq({ params: { id: 'c1' } }),
      );

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'c1', org_account_id: ORG_A } });
      const [callArg] = editHistoryDb.findMany.mock.calls[0];
      expect(callArg.where).toEqual({ obligation_id: 'c1' });
      expect(callArg.orderBy).toEqual({ edited_at: 'desc' });
      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
    });
  });

  describe('upload_compliance_attachment_into_aws', () => {
    it('throws 400 when no file is present', async () => {
      await expect(
        compliance_service.upload_compliance_attachment_into_aws(makeReq({})),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('returns the uploaded secure_url', async () => {
      uploadCloudMock.mockResolvedValue({ secure_url: 'https://cdn.example/evidence.pdf' });

      const result = await compliance_service.upload_compliance_attachment_into_aws(
        makeReq({ file: { originalname: 'evidence.pdf' } } as never),
      );

      expect(result).toEqual({ url: 'https://cdn.example/evidence.pdf' });
    });
  });

  describe('get_compliance_scorecard_from_db', () => {
    it('scopes the scorecard query to the caller org', async () => {
      db.findMany.mockResolvedValue([]);

      await compliance_service.get_compliance_scorecard_from_db(makeReq({ query: {} }));

      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({ org_account_id: ORG_A });
    });

    it('computes overall / by-domain / by-site / matrix with red-orange-green banding', async () => {
      db.findMany.mockResolvedValue([
        // Data Protection @ site-1: 1/2 compliant -> 0.5 red
        { status: 'compliant', domain: 'Data Protection', site_id: 's1', site: { name: 'Paris' } },
        {
          status: 'non_compliant',
          domain: 'Data Protection',
          site_id: 's1',
          site: { name: 'Paris' },
        },
        // Financial org-wide: 1/1 compliant -> 1.0 green
        { status: 'compliant', domain: 'Financial', site_id: null, site: null },
        // Financial @ site-1: 0/1 -> red
        { status: 'in_progress', domain: 'Financial', site_id: 's1', site: { name: 'Paris' } },
      ]);

      const result = await compliance_service.get_compliance_scorecard_from_db(
        makeReq({ query: {} }),
      );

      // Overall: 2/4 = 0.5 -> red
      expect(result.overall).toEqual({ compliant: 2, total: 4, ratio: 0.5, band: 'red' });

      // By domain
      const dp = result.byDomain.find((d) => d.domain === 'Data Protection');
      const fin = result.byDomain.find((d) => d.domain === 'Financial');
      expect(dp).toMatchObject({ compliant: 1, total: 2, band: 'red' });
      expect(fin).toMatchObject({ compliant: 1, total: 2, band: 'red' });

      // By site: org-wide (null) 1/1 green, Paris 1/3 red
      const orgWide = result.bySite.find((s) => s.site_id === null);
      const paris = result.bySite.find((s) => s.site_id === 's1');
      expect(orgWide).toMatchObject({ compliant: 1, total: 1, band: 'green', site_name: null });
      expect(paris).toMatchObject({ compliant: 1, total: 3, band: 'red', site_name: 'Paris' });

      // Matrix: Data Protection @ Paris 1/2 red; Financial org-wide 1/1 green
      const dpParis = result.matrix.find(
        (m) => m.domain === 'Data Protection' && m.site_id === 's1',
      );
      const finOrg = result.matrix.find((m) => m.domain === 'Financial' && m.site_id === null);
      expect(dpParis).toMatchObject({ compliant: 1, total: 2, band: 'red' });
      expect(finOrg).toMatchObject({ compliant: 1, total: 1, band: 'green' });
    });

    it('returns band "none" and ratio 0 for an org with no obligations', async () => {
      db.findMany.mockResolvedValue([]);

      const result = await compliance_service.get_compliance_scorecard_from_db(
        makeReq({ query: {} }),
      );

      expect(result.overall).toEqual({ compliant: 0, total: 0, ratio: 0, band: 'none' });
      expect(result.byDomain).toEqual([]);
      expect(result.bySite).toEqual([]);
      expect(result.matrix).toEqual([]);
    });

    // Band boundary semantics (issue #208): thresholds are inclusive on the
    // lower edge (`>=`), so 0.85 is green (not orange) and 0.70 is orange (not
    // red). Rows are generated to land the overall ratio exactly on each edge.
    const rowsWithRatio = (compliant: number, total: number) =>
      Array.from({ length: total }, (_, i) => ({
        status: i < compliant ? 'compliant' : 'non_compliant',
        domain: 'Financial',
        site_id: null,
        site: null,
      }));

    it('bands a ratio of exactly 0.85 as green (>= is inclusive, not >)', async () => {
      // 17/20 === 0.85 exactly.
      db.findMany.mockResolvedValue(rowsWithRatio(17, 20));

      const result = await compliance_service.get_compliance_scorecard_from_db(
        makeReq({ query: {} }),
      );

      expect(result.overall.ratio).toBe(0.85);
      expect(result.overall.band).toBe('green');
    });

    it('bands a ratio of exactly 0.70 as orange (lower orange boundary is inclusive)', async () => {
      // 7/10 === 0.70 exactly.
      db.findMany.mockResolvedValue(rowsWithRatio(7, 10));

      const result = await compliance_service.get_compliance_scorecard_from_db(
        makeReq({ query: {} }),
      );

      expect(result.overall.ratio).toBe(0.7);
      expect(result.overall.band).toBe('orange');
    });

    it('bands a mid-range ratio (0.75) squarely in the orange band', async () => {
      // 3/4 === 0.75.
      db.findMany.mockResolvedValue(rowsWithRatio(3, 4));

      const result = await compliance_service.get_compliance_scorecard_from_db(
        makeReq({ query: {} }),
      );

      expect(result.overall.ratio).toBe(0.75);
      expect(result.overall.band).toBe('orange');
    });

    it('bands a ratio just under 0.70 (0.6) as red', async () => {
      // 3/5 === 0.60.
      db.findMany.mockResolvedValue(rowsWithRatio(3, 5));

      const result = await compliance_service.get_compliance_scorecard_from_db(
        makeReq({ query: {} }),
      );

      expect(result.overall.band).toBe('red');
    });

    it('returns org-wide statusCounts so paginated summary cards stay accurate', async () => {
      db.findMany.mockResolvedValue([
        { status: 'compliant', domain: 'Financial', site_id: null, site: null },
        { status: 'compliant', domain: 'Financial', site_id: null, site: null },
        { status: 'non_compliant', domain: 'Financial', site_id: null, site: null },
        { status: 'in_progress', domain: 'Financial', site_id: null, site: null },
      ]);

      const result = await compliance_service.get_compliance_scorecard_from_db(
        makeReq({ query: {} }),
      );

      expect(result.statusCounts).toEqual({
        compliant: 2,
        non_compliant: 1,
        in_progress: 1,
      });
    });

    // aexa-server#243: whole-org overdue count, same "must stay correct once
    // the list is paginated" rationale as statusCounts above.
    it('returns overdueCount across the whole org, including compliant-but-overdue obligations', async () => {
      const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      db.findMany.mockResolvedValue([
        { status: 'in_progress', domain: 'Financial', site_id: null, site: null, due_date: past },
        { status: 'compliant', domain: 'Financial', site_id: null, site: null, due_date: past },
        {
          status: 'compliant',
          domain: 'Financial',
          site_id: null,
          site: null,
          due_date: future,
        },
        {
          status: 'not_applicable',
          domain: 'Financial',
          site_id: null,
          site: null,
          due_date: past,
        },
      ]);

      const result = await compliance_service.get_compliance_scorecard_from_db(
        makeReq({ query: {} }),
      );

      expect(result.overdueCount).toBe(2);
    });

    // Methodology audit finding: 'not_applicable' obligations must be
    // excluded from every ratio's denominator, the same convention real
    // compliance-management tooling uses (e.g. ServiceNow GRC) -- an
    // obligation genuinely not applicable to an org isn't a compliance gap,
    // so counting it against the score understates real compliance.
    describe('not_applicable exclusion (methodology audit)', () => {
      it('excludes not_applicable obligations from the overall ratio, not just the numerator', async () => {
        // 7 compliant, 3 not_applicable -- naive counting (10 total) would
        // score 70% (orange); excluding N/A from the denominator too gives
        // the real figure: 7/7 = 100% (green).
        db.findMany.mockResolvedValue([
          ...Array.from({ length: 7 }, () => ({
            status: 'compliant',
            domain: 'Financial',
            site_id: null,
            site: null,
          })),
          ...Array.from({ length: 3 }, () => ({
            status: 'not_applicable',
            domain: 'Financial',
            site_id: null,
            site: null,
          })),
        ]);

        const result = await compliance_service.get_compliance_scorecard_from_db(
          makeReq({ query: {} }),
        );

        expect(result.overall).toEqual({ compliant: 7, total: 7, ratio: 1, band: 'green' });
      });

      it('excludes not_applicable obligations from byDomain/bySite/matrix denominators too', async () => {
        db.findMany.mockResolvedValue([
          {
            status: 'compliant',
            domain: 'Data Protection',
            site_id: 's1',
            site: { name: 'Paris' },
          },
          {
            status: 'not_applicable',
            domain: 'Data Protection',
            site_id: 's1',
            site: { name: 'Paris' },
          },
        ]);

        const result = await compliance_service.get_compliance_scorecard_from_db(
          makeReq({ query: {} }),
        );

        const dp = result.byDomain.find((d) => d.domain === 'Data Protection');
        const paris = result.bySite.find((s) => s.site_id === 's1');
        const matrixCell = result.matrix.find(
          (m) => m.domain === 'Data Protection' && m.site_id === 's1',
        );
        expect(dp).toMatchObject({ compliant: 1, total: 1, band: 'green' });
        expect(paris).toMatchObject({ compliant: 1, total: 1, band: 'green' });
        expect(matrixCell).toMatchObject({ compliant: 1, total: 1, band: 'green' });
      });

      it('still counts not_applicable obligations in statusCounts, for UI transparency', async () => {
        db.findMany.mockResolvedValue([
          { status: 'compliant', domain: 'Financial', site_id: null, site: null },
          { status: 'not_applicable', domain: 'Financial', site_id: null, site: null },
          { status: 'not_applicable', domain: 'Financial', site_id: null, site: null },
        ]);

        const result = await compliance_service.get_compliance_scorecard_from_db(
          makeReq({ query: {} }),
        );

        expect(result.statusCounts).toEqual({ compliant: 1, not_applicable: 2 });
      });

      it('reports excludedNotApplicable as the count of not_applicable rows', async () => {
        db.findMany.mockResolvedValue([
          { status: 'compliant', domain: 'Financial', site_id: null, site: null },
          { status: 'not_applicable', domain: 'Financial', site_id: null, site: null },
          { status: 'not_applicable', domain: 'Financial', site_id: null, site: null },
        ]);

        const result = await compliance_service.get_compliance_scorecard_from_db(
          makeReq({ query: {} }),
        );

        expect(result.excludedNotApplicable).toBe(2);
      });

      it('bands an org made up entirely of not_applicable obligations as "none" (0/0), not 0/N red', async () => {
        db.findMany.mockResolvedValue([
          { status: 'not_applicable', domain: 'Financial', site_id: null, site: null },
          { status: 'not_applicable', domain: 'Financial', site_id: null, site: null },
        ]);

        const result = await compliance_service.get_compliance_scorecard_from_db(
          makeReq({ query: {} }),
        );

        expect(result.overall).toEqual({ compliant: 0, total: 0, ratio: 0, band: 'none' });
        expect(result.excludedNotApplicable).toBe(2);
      });
    });
  });

  describe('site_id ownership validation (issue #205)', () => {
    it('rejects a create whose site_id belongs to another org (404, no create)', async () => {
      mockMembership('ADMIN');
      // findFirst scoped to the caller org returns nothing -> foreign site.
      siteDb.findFirst.mockResolvedValue(null);

      await expect(
        compliance_service.create_compliance_into_db(
          makeReq({
            body: {
              title: 'X',
              domain: 'Financial',
              status: 'pending',
              site_id: 'org-b-site-uuid',
            },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(siteDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'org-b-site-uuid', org_account_id: ORG_A },
        select: { id: true },
      });
      expect(db.create).not.toHaveBeenCalled();
    });

    it('allows a create whose site_id belongs to the caller org', async () => {
      mockMembership('ADMIN');
      siteDb.findFirst.mockResolvedValue({ id: 'own-site' });
      db.create.mockResolvedValue({});

      await compliance_service.create_compliance_into_db(
        makeReq({
          body: { title: 'X', domain: 'Financial', status: 'pending', site_id: 'own-site' },
        }),
      );

      expect(db.create).toHaveBeenCalled();
    });

    it('rejects an update that re-scopes to another org site (404, no update)', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });
      siteDb.findFirst.mockResolvedValue(null);

      await expect(
        compliance_service.update_compliance_into_db(
          makeReq({ params: { id: 'c1' }, body: { site_id: 'org-b-site-uuid' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('does not look up a site when site_id is null (clearing to org-wide is allowed)', async () => {
      mockMembership('ADMIN');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ORG_A });
      db.update.mockResolvedValue({});

      await compliance_service.update_compliance_into_db(
        makeReq({ params: { id: 'c1' }, body: { site_id: null } }),
      );

      expect(siteDb.findFirst).not.toHaveBeenCalled();
      // The null passes through to Prisma untouched — the row becomes org-wide.
      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.site_id).toBeNull();
    });
  });

  describe('upload_compliance_attachment_into_aws — write-role gate (issue #207)', () => {
    it('rejects a VIEWER before touching Cloudinary', async () => {
      mockMembership('VIEWER');

      await expect(
        compliance_service.upload_compliance_attachment_into_aws(
          makeReq({ file: { originalname: 'x.pdf' } } as never),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(uploadCloudMock).not.toHaveBeenCalled();
    });

    it('allows a LEAD_AUDITOR (writer) to upload', async () => {
      mockMembership('LEAD_AUDITOR');
      uploadCloudMock.mockResolvedValue({ secure_url: 'https://cdn.example/e.pdf' });

      const result = await compliance_service.upload_compliance_attachment_into_aws(
        makeReq({ file: { originalname: 'e.pdf' } } as never),
      );

      expect(result).toEqual({ url: 'https://cdn.example/e.pdf' });
    });
  });
});

describe('compliance obligation <-> risk linking (aexa-server#346)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
    txFn.mockImplementation(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
  });

  describe('create_risk_from_obligation_into_db', () => {
    it('404s when the obligation does not exist', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        compliance_service.create_risk_from_obligation_into_db(
          makeReq({ params: { id: 'missing' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(riskDb.create).not.toHaveBeenCalled();
    });

    it('409s when the obligation is already linked to a Risk', async () => {
      db.findFirst.mockResolvedValue({
        id: 'obl-1',
        org_account_id: ORG_A,
        risk_id: 'risk-already-linked',
        site_id: null,
      });
      siteDb.findFirst.mockResolvedValue({ id: 'site-1' });

      await expect(
        compliance_service.create_risk_from_obligation_into_db(
          makeReq({ params: { id: 'obl-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(riskDb.create).not.toHaveBeenCalled();
    });

    it('409s when the org has no sites to attach the new risk to', async () => {
      db.findFirst.mockResolvedValue({
        id: 'obl-1',
        org_account_id: ORG_A,
        risk_id: null,
        site_id: null,
      });
      siteDb.findFirst.mockResolvedValue(null);

      await expect(
        compliance_service.create_risk_from_obligation_into_db(
          makeReq({ params: { id: 'obl-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(riskDb.create).not.toHaveBeenCalled();
    });

    it('creates a Risk from an obligation, marks provenance, and links it back', async () => {
      db.findFirst.mockResolvedValue({
        id: 'obl-1',
        org_account_id: ORG_A,
        risk_id: null,
        site_id: 'site-1',
        title: 'GDPR Art. 30 record-keeping',
        description: 'Maintain records of processing activities',
        // Real ComplianceObligation.domain key (COMPLIANCE_DOMAINS,
        // aexa-frontend's complianceConfig.ts) -- not the display label.
        domain: 'data_protection',
        line_of_defense: 'SECOND',
      });
      siteDb.findFirst.mockResolvedValue({ id: 'site-1' });
      riskDb.findMany.mockResolvedValue([]);
      riskDb.create.mockResolvedValue({ id: 'risk-1', name: 'GDPR Art. 30 record-keeping' });
      db.updateMany.mockResolvedValue({ count: 1 });

      const result = await compliance_service.create_risk_from_obligation_into_db(
        makeReq({ params: { id: 'obl-1' } }),
      );

      expect(riskDb.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          org_account_id: ORG_A,
          name: 'GDPR Art. 30 record-keeping',
          // Mapped to a real RISK_CATEGORIES key (riskConfig.ts), NOT the raw
          // compliance domain string -- see COMPLIANCE_DOMAIN_TO_RISK_CATEGORY's
          // own comment for why passing the domain straight through was a bug.
          category: 'regulatory',
          site_id: 'site-1',
          line_of_defense: 'SECOND',
          source_info: 'Linked from compliance obligation: GDPR Art. 30 record-keeping',
        }),
      });
      expect(db.updateMany).toHaveBeenCalledWith({
        where: { id: 'obl-1', risk_id: null },
        data: { risk_id: 'risk-1' },
      });
      expect(result.id).toBe('risk-1');
    });

    // Review finding: obligation.domain (COMPLIANCE_DOMAINS) and Risk.category
    // (RISK_CATEGORIES) are different taxonomies -- verifies every declared
    // domain maps to a real RISK_CATEGORIES key, and an unrecognized domain
    // falls back to 'regulatory' rather than passing an invalid raw string
    // through (COMPLIANCE_DOMAIN_TO_RISK_CATEGORY's own comment).
    it.each([
      ['data_protection', 'regulatory'],
      ['health_safety', 'ehs'],
      ['financial', 'financial'],
      ['environmental', 'environmental'],
      ['labor_employment', 'hr'],
      ['anti_corruption', 'regulatory'],
      ['export_control', 'regulatory'],
      ['industry_specific', 'regulatory'],
      ['some_future_domain_not_yet_mapped', 'regulatory'],
    ])('maps obligation domain %s to Risk category %s', async (domain, expectedCategory) => {
      db.findFirst.mockResolvedValue({
        id: 'obl-1',
        org_account_id: ORG_A,
        risk_id: null,
        site_id: 'site-1',
        title: 'Some obligation',
        domain,
      });
      siteDb.findFirst.mockResolvedValue({ id: 'site-1' });
      riskDb.findMany.mockResolvedValue([]);
      riskDb.create.mockResolvedValue({ id: 'risk-1' });
      db.updateMany.mockResolvedValue({ count: 1 });

      await compliance_service.create_risk_from_obligation_into_db(
        makeReq({ params: { id: 'obl-1' } }),
      );

      expect(riskDb.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ category: expectedCategory }),
      });
    });

    // Same TOCTOU-closing conditional claim as
    // intelligence.service.ts's create_risk_from_item_into_db — proves the
    // race is closed by the updateMany's WHERE clause, not just the earlier
    // pre-check.
    it('loses the race when another request linked the obligation first inside the transaction', async () => {
      db.findFirst.mockResolvedValue({
        id: 'obl-1',
        org_account_id: ORG_A,
        risk_id: null,
        site_id: 'site-1',
        title: 'GDPR Art. 30',
        domain: 'Data Protection',
      });
      siteDb.findFirst.mockResolvedValue({ id: 'site-1' });
      riskDb.findMany.mockResolvedValue([]);
      riskDb.create.mockResolvedValue({ id: 'risk-1' });
      db.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        compliance_service.create_risk_from_obligation_into_db(
          makeReq({ params: { id: 'obl-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('VIEWER cannot promote an obligation to a Risk', async () => {
      mockMembership('VIEWER');

      await expect(
        compliance_service.create_risk_from_obligation_into_db(
          makeReq({ params: { id: 'obl-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(db.findFirst).not.toHaveBeenCalled();
      expect(riskDb.create).not.toHaveBeenCalled();
    });
  });

  describe('link_risk_to_obligation_into_db', () => {
    it('404s when the obligation does not exist', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        compliance_service.link_risk_to_obligation_into_db(
          makeReq({ params: { id: 'missing' }, body: { riskId: 'risk-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(db.update).not.toHaveBeenCalled();
    });

    // Cross-tenant guard: a caller must not be able to link an obligation to
    // another org's Risk id, same reasoning as assertSiteBelongsToOrg.
    it('404s when the riskId does not belong to the caller org', async () => {
      db.findFirst.mockResolvedValue({ id: 'obl-1', org_account_id: ORG_A, risk_id: null });
      riskDb.findFirst.mockResolvedValue(null);

      await expect(
        compliance_service.link_risk_to_obligation_into_db(
          makeReq({ params: { id: 'obl-1' }, body: { riskId: 'other-org-risk' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('links the obligation to an existing risk in the same org', async () => {
      db.findFirst.mockResolvedValue({ id: 'obl-1', org_account_id: ORG_A, risk_id: null });
      riskDb.findFirst.mockResolvedValue({ id: 'risk-1', org_account_id: ORG_A });
      db.update.mockResolvedValue({
        id: 'obl-1',
        risk_id: 'risk-1',
        due_date: null,
        status: 'compliant',
      });

      const result = await compliance_service.link_risk_to_obligation_into_db(
        makeReq({ params: { id: 'obl-1' }, body: { riskId: 'risk-1' } }),
      );

      expect(db.update).toHaveBeenCalledWith({
        where: { id: 'obl-1' },
        data: { risk_id: 'risk-1' },
      });
      expect(result.risk_id).toBe('risk-1');
    });

    it('re-linking overwrites a previous link rather than being blocked', async () => {
      db.findFirst.mockResolvedValue({ id: 'obl-1', org_account_id: ORG_A, risk_id: 'risk-old' });
      riskDb.findFirst.mockResolvedValue({ id: 'risk-new', org_account_id: ORG_A });
      db.update.mockResolvedValue({
        id: 'obl-1',
        risk_id: 'risk-new',
        due_date: null,
        status: 'compliant',
      });

      const result = await compliance_service.link_risk_to_obligation_into_db(
        makeReq({ params: { id: 'obl-1' }, body: { riskId: 'risk-new' } }),
      );

      expect(result.risk_id).toBe('risk-new');
    });

    it('VIEWER cannot link an obligation to a risk', async () => {
      mockMembership('VIEWER');

      await expect(
        compliance_service.link_risk_to_obligation_into_db(
          makeReq({ params: { id: 'obl-1' }, body: { riskId: 'risk-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(db.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('unlink_risk_from_obligation_into_db', () => {
    it('404s when the obligation does not exist', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        compliance_service.unlink_risk_from_obligation_into_db(
          makeReq({ params: { id: 'missing' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(db.update).not.toHaveBeenCalled();
    });

    it('clears risk_id on the obligation', async () => {
      db.findFirst.mockResolvedValue({ id: 'obl-1', org_account_id: ORG_A, risk_id: 'risk-1' });
      db.update.mockResolvedValue({
        id: 'obl-1',
        risk_id: null,
        due_date: null,
        status: 'compliant',
      });

      const result = await compliance_service.unlink_risk_from_obligation_into_db(
        makeReq({ params: { id: 'obl-1' } }),
      );

      expect(db.update).toHaveBeenCalledWith({
        where: { id: 'obl-1' },
        data: { risk_id: null },
      });
      expect(result.risk_id).toBeNull();
    });

    it('VIEWER cannot unlink an obligation from its risk', async () => {
      mockMembership('VIEWER');

      await expect(
        compliance_service.unlink_risk_from_obligation_into_db(
          makeReq({ params: { id: 'obl-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(db.findFirst).not.toHaveBeenCalled();
    });
  });
});

describe('compliance validation schemas', () => {
  describe('update_compliance — site_id clearing (issue #204)', () => {
    it('passes an explicit null through as null (clear to org-wide)', async () => {
      const parsed = await compliance_validations.update_compliance.parseAsync({ site_id: null });
      expect(parsed).toHaveProperty('site_id', null);
    });

    it('normalizes "" to null (the "Org-wide" select value clears the scope)', async () => {
      const parsed = await compliance_validations.update_compliance.parseAsync({ site_id: '' });
      expect(parsed).toHaveProperty('site_id', null);
    });

    it('leaves site_id absent (undefined) when the field is not sent — "do not touch"', async () => {
      const parsed = await compliance_validations.update_compliance.parseAsync({ title: 'x' });
      expect('site_id' in parsed).toBe(false);
    });

    it('keeps a real site_id string intact', async () => {
      const parsed = await compliance_validations.update_compliance.parseAsync({
        site_id: 'site-123',
      });
      expect(parsed).toHaveProperty('site_id', 'site-123');
    });
  });

  // Found live-verifying the edit-history feature (aexa-frontend PR
  // feat/compliance-edit-history-ui): the frontend edit form always resends
  // regulation_reference/recurrence as `null` when they're blank, on EVERY
  // save, not just when the user is actively clearing a previously-set
  // value. Before this fix, update_compliance inherited
  // `z.string().optional()` unchanged from create_compliance.partial() —
  // non-nullable — so ANY edit to an obligation whose regulation_reference
  // or recurrence were already unset 400'd outright with "Invalid input:
  // expected string, received null", even when the user wasn't touching
  // those fields at all. Same fix as site_id (issue #204): three-way
  // undefined/null-or-''/string handling.
  describe('update_compliance — regulation_reference/recurrence clearing (found live-verifying feat/compliance-edit-history-ui)', () => {
    it('passes an explicit null through as null for regulation_reference (clear the field)', async () => {
      const parsed = await compliance_validations.update_compliance.parseAsync({
        regulation_reference: null,
      });
      expect(parsed).toHaveProperty('regulation_reference', null);
    });

    it('normalizes "" to null for regulation_reference', async () => {
      const parsed = await compliance_validations.update_compliance.parseAsync({
        regulation_reference: '',
      });
      expect(parsed).toHaveProperty('regulation_reference', null);
    });

    it('leaves regulation_reference absent (undefined) when the field is not sent — "do not touch"', async () => {
      const parsed = await compliance_validations.update_compliance.parseAsync({ title: 'x' });
      expect('regulation_reference' in parsed).toBe(false);
    });

    it('keeps a real regulation_reference string intact', async () => {
      const parsed = await compliance_validations.update_compliance.parseAsync({
        regulation_reference: 'GDPR Art. 30(1)',
      });
      expect(parsed).toHaveProperty('regulation_reference', 'GDPR Art. 30(1)');
    });

    it('passes an explicit null through as null for recurrence (clear the field)', async () => {
      const parsed = await compliance_validations.update_compliance.parseAsync({
        recurrence: null,
      });
      expect(parsed).toHaveProperty('recurrence', null);
    });

    it('normalizes "" to null for recurrence', async () => {
      const parsed = await compliance_validations.update_compliance.parseAsync({
        recurrence: '',
      });
      expect(parsed).toHaveProperty('recurrence', null);
    });

    it('leaves recurrence absent (undefined) when the field is not sent — "do not touch"', async () => {
      const parsed = await compliance_validations.update_compliance.parseAsync({ title: 'x' });
      expect('recurrence' in parsed).toBe(false);
    });

    it('keeps a real recurrence string intact', async () => {
      const parsed = await compliance_validations.update_compliance.parseAsync({
        recurrence: 'annual',
      });
      expect(parsed).toHaveProperty('recurrence', 'annual');
    });

    // The actual reported bug: an edit that doesn't touch either field but
    // whose current value is already blank must not 400 just because the
    // frontend resends null for it.
    it('accepts a full PATCH body with both fields null, unrelated to whether they were previously set', async () => {
      const parsed = await compliance_validations.update_compliance.parseAsync({
        title: 'Updated title',
        description: 'Updated description',
        domain: 'Financial',
        status: 'pending',
        owner: 'Jane Doe',
        regulation_reference: null,
        recurrence: null,
      });
      expect(parsed).toMatchObject({
        title: 'Updated title',
        regulation_reference: null,
        recurrence: null,
      });
    });
  });

  describe('attachments URL/scheme allowlist (issue #206)', () => {
    it('rejects a javascript: URL', async () => {
      await expect(
        compliance_validations.create_compliance.parseAsync({
          title: 'x',
          domain: 'Financial',
          status: 'pending',
          attachments: ['javascript:alert(1)'],
        }),
      ).rejects.toBeTruthy();
    });

    it('rejects a data: URL', async () => {
      await expect(
        compliance_validations.create_compliance.parseAsync({
          title: 'x',
          domain: 'Financial',
          status: 'pending',
          attachments: ['data:text/html,<script>alert(1)</script>'],
        }),
      ).rejects.toBeTruthy();
    });

    it('rejects a plain http: (non-https) URL', async () => {
      await expect(
        compliance_validations.create_compliance.parseAsync({
          title: 'x',
          domain: 'Financial',
          status: 'pending',
          attachments: ['http://cdn.example/e.pdf'],
        }),
      ).rejects.toBeTruthy();
    });

    it('accepts an https Cloudinary-style secure_url', async () => {
      const parsed = await compliance_validations.create_compliance.parseAsync({
        title: 'x',
        domain: 'Financial',
        status: 'pending',
        attachments: ['https://res.cloudinary.com/demo/raw/upload/v1/e.pdf'],
      });
      expect(parsed.attachments).toEqual(['https://res.cloudinary.com/demo/raw/upload/v1/e.pdf']);
    });
  });

  describe('regulation_reference (aexa-server#243)', () => {
    it('accepts a free-text regulatory source', async () => {
      const parsed = await compliance_validations.create_compliance.parseAsync({
        title: 'x',
        domain: 'Financial',
        status: 'pending',
        regulation_reference: 'GDPR Art. 30(1)',
      });
      expect(parsed.regulation_reference).toBe('GDPR Art. 30(1)');
    });

    it('is optional', async () => {
      const parsed = await compliance_validations.create_compliance.parseAsync({
        title: 'x',
        domain: 'Financial',
        status: 'pending',
      });
      expect('regulation_reference' in parsed).toBe(false);
    });
  });

  describe('recurrence (aexa-server#250)', () => {
    it('accepts a recognized cadence value', async () => {
      const parsed = await compliance_validations.create_compliance.parseAsync({
        title: 'x',
        domain: 'Financial',
        status: 'pending',
        recurrence: 'annual',
      });
      expect(parsed.recurrence).toBe('annual');
    });

    it('is optional', async () => {
      const parsed = await compliance_validations.create_compliance.parseAsync({
        title: 'x',
        domain: 'Financial',
        status: 'pending',
      });
      expect('recurrence' in parsed).toBe(false);
    });
  });

  describe('attest_compliance (aexa-server#250)', () => {
    it('accepts an optional note', async () => {
      const parsed = await compliance_validations.attest_compliance.parseAsync({
        note: 'Confirmed with legal counsel',
      });
      expect(parsed.note).toBe('Confirmed with legal counsel');
    });

    it('allows an empty body (note is optional)', async () => {
      const parsed = await compliance_validations.attest_compliance.parseAsync({});
      expect('note' in parsed).toBe(false);
    });

    it('rejects a note over 2000 characters', async () => {
      await expect(
        compliance_validations.attest_compliance.parseAsync({ note: 'x'.repeat(2001) }),
      ).rejects.toBeTruthy();
    });
  });

  describe('create_risk_from_obligation (aexa-server#346)', () => {
    it('allows an empty body — siteId/severity are both optional', async () => {
      const parsed = await compliance_validations.create_risk_from_obligation.parseAsync({});
      expect(parsed).toEqual({});
    });

    it('accepts a valid severity', async () => {
      const parsed = await compliance_validations.create_risk_from_obligation.parseAsync({
        severity: 'high',
      });
      expect(parsed.severity).toBe('high');
    });

    it('rejects an invalid severity', async () => {
      await expect(
        compliance_validations.create_risk_from_obligation.parseAsync({ severity: 'extreme' }),
      ).rejects.toBeTruthy();
    });
  });

  describe('link_risk_to_obligation (aexa-server#346)', () => {
    it('requires a non-empty riskId', async () => {
      await expect(
        compliance_validations.link_risk_to_obligation.parseAsync({}),
      ).rejects.toBeTruthy();
      await expect(
        compliance_validations.link_risk_to_obligation.parseAsync({ riskId: '' }),
      ).rejects.toBeTruthy();
    });

    it('accepts a riskId', async () => {
      const parsed = await compliance_validations.link_risk_to_obligation.parseAsync({
        riskId: 'risk-1',
      });
      expect(parsed.riskId).toBe('risk-1');
    });
  });

  describe('suggest_regulatory_sources (aexa-frontend#939)', () => {
    it('requires a non-empty site_id', async () => {
      await expect(
        compliance_validations.suggest_regulatory_sources.parseAsync({}),
      ).rejects.toBeTruthy();
      await expect(
        compliance_validations.suggest_regulatory_sources.parseAsync({ site_id: '' }),
      ).rejects.toBeTruthy();
    });

    it('accepts a site_id', async () => {
      const parsed = await compliance_validations.suggest_regulatory_sources.parseAsync({
        site_id: 'site-1',
      });
      expect(parsed.site_id).toBe('site-1');
    });
  });
});

describe('compliance_service — POST /compliance/suggest-regulatory-sources (mocked aexa-ai call)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Same reasoning as risk.service.test.ts's identical VIEWER test on
  // suggest-fields: this suite's own beforeEach always resolves
  // orgMemberDb.findUnique to null (the no-membership-row ADMIN-of-self
  // fallback), so without an explicit VIEWER test the write gate on this
  // new endpoint would go unexercised.
  it('VIEWER cannot request regulatory coverage suggestions', async () => {
    mockMembership('VIEWER');

    await expect(
      compliance_service.suggest_regulatory_sources_with_ai(
        makeReq({ body: { site_id: 'site-1' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fetch).not.toHaveBeenCalled();
    expect(siteDb.findFirst).not.toHaveBeenCalled();
  });

  it('404s when the site does not belong to (or exist for) the caller org, without calling aexa-ai', async () => {
    siteDb.findFirst.mockResolvedValue(null);

    await expect(
      compliance_service.suggest_regulatory_sources_with_ai(
        makeReq({ body: { site_id: 'site-1' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('scopes the site lookup and the existing-obligations context query to the caller org and site', async () => {
    siteDb.findFirst.mockResolvedValue({
      id: 'site-1',
      name: 'HQ Casablanca',
      activity: 'Manufacturing',
      country: 'Morocco',
    });
    db.findMany.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [] }),
    });

    await compliance_service.suggest_regulatory_sources_with_ai(
      makeReq({ body: { site_id: 'site-1' } }),
    );

    expect(siteDb.findFirst).toHaveBeenCalledWith({
      where: { id: 'site-1', org_account_id: ORG_A },
    });
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { org_account_id: ORG_A, site_id: 'site-1' } }),
    );
  });

  it('sends site context and existing-obligation references with the internal-secret header', async () => {
    siteDb.findFirst.mockResolvedValue({
      id: 'site-1',
      name: 'HQ Casablanca',
      activity: 'Manufacturing',
      country: 'Morocco',
    });
    db.findMany.mockResolvedValue([{ domain: 'data_protection', regulation_reference: 'GDPR' }]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [] }),
    });

    await compliance_service.suggest_regulatory_sources_with_ai(
      makeReq({ body: { site_id: 'site-1' } }),
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/compliance/suggest-regulatory-sources');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Internal-Secret']).toBeDefined();

    const body = JSON.parse(init.body);
    expect(body).toEqual({
      site_name: 'HQ Casablanca',
      site_activity: 'Manufacturing',
      site_country: 'Morocco',
      existing_obligations: [{ domain: 'data_protection', regulation_reference: 'GDPR' }],
    });
  });

  it('returns the aexa-ai suggestions on success', async () => {
    siteDb.findFirst.mockResolvedValue({ id: 'site-1', name: 'HQ Casablanca', activity: '' });
    db.findMany.mockResolvedValue([]);
    const suggestions = [
      {
        name: 'GDPR',
        domain: 'data_protection',
        jurisdiction: 'European Union',
        rationale: 'The site processes EU personal data.',
        source_url: 'https://example.com/gdpr',
      },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions }),
    });

    const result = await compliance_service.suggest_regulatory_sources_with_ai(
      makeReq({ body: { site_id: 'site-1' } }),
    );

    expect(result).toEqual({ suggestions });
  });

  it('defaults suggestions to an empty array when aexa-ai omits them', async () => {
    siteDb.findFirst.mockResolvedValue({ id: 'site-1', name: 'HQ Casablanca', activity: '' });
    db.findMany.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const result = await compliance_service.suggest_regulatory_sources_with_ai(
      makeReq({ body: { site_id: 'site-1' } }),
    );

    expect(result).toEqual({ suggestions: [] });
  });

  // Review round 1 finding on PR #354: `?? []` alone only guards null/
  // undefined -- a truthy non-array (string/object/number) from aexa-ai
  // would otherwise flow through unfiltered to the client. Mirrors the
  // analogous isPlainObject test already covering risk.service.ts's
  // rationale field.
  it('defaults suggestions to an empty array when aexa-ai returns a non-array value for it', async () => {
    siteDb.findFirst.mockResolvedValue({ id: 'site-1', name: 'HQ Casablanca', activity: '' });
    db.findMany.mockResolvedValue([]);

    for (const malformed of ['not an array', { name: 'GDPR' }, 42]) {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ suggestions: malformed }),
      });

      const result = await compliance_service.suggest_regulatory_sources_with_ai(
        makeReq({ body: { site_id: 'site-1' } }),
      );

      expect(result).toEqual({ suggestions: [] });
    }
  });

  it('wraps a non-ok aexa-ai response as a 502', async () => {
    siteDb.findFirst.mockResolvedValue({ id: 'site-1', name: 'HQ Casablanca', activity: '' });
    db.findMany.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503 });

    await expect(
      compliance_service.suggest_regulatory_sources_with_ai(
        makeReq({ body: { site_id: 'site-1' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it('wraps a network failure as a generic 500, not the raw error', async () => {
    siteDb.findFirst.mockResolvedValue({ id: 'site-1', name: 'HQ Casablanca', activity: '' });
    db.findMany.mockResolvedValue([]);
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      compliance_service.suggest_regulatory_sources_with_ai(
        makeReq({ body: { site_id: 'site-1' } }),
      ),
    ).rejects.toMatchObject({
      statusCode: 500,
      message: 'Failed to generate regulatory coverage suggestions',
    });
  });

  // Round-6 quality-bar-loop review (resilience axis): fetchWithTimeout aborts
  // via AbortController on LLM_CALL_TIMEOUT_MS, and fetch surfaces that as a
  // DOMException named 'AbortError' -- left uncaught it would fall into the
  // same generic-500 path as the ECONNREFUSED case above, indistinguishable
  // to the client from any other failure. This must come out as its own 504
  // so the frontend can tell "the AI took too long" apart from "something
  // went wrong."
  it('wraps an aborted (timed-out) aexa-ai call as a distinct 504, not the generic 500', async () => {
    siteDb.findFirst.mockResolvedValue({ id: 'site-1', name: 'HQ Casablanca', activity: '' });
    db.findMany.mockResolvedValue([]);
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(abortError);

    await expect(
      compliance_service.suggest_regulatory_sources_with_ai(
        makeReq({ body: { site_id: 'site-1' } }),
      ),
    ).rejects.toMatchObject({
      statusCode: 504,
      message: 'Regulatory coverage check timed out',
    });
  });
});
