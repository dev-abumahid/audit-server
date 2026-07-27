import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    complianceObligation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    // aexa-server#250: re-attestation history, and next_review_date
    // advancement, wrapped in a $transaction.
    complianceAttestation: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
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
  compliance_service,
  compute_obligation_overdue,
} from '../../app/modules/compliance/compliance.service.js';
import { compliance_validations } from '../../app/modules/compliance/compliance.validation.js';
import uploadCloud from '../../app/utils/cloudinary.js';

const db = prisma.complianceObligation as unknown as Record<string, ReturnType<typeof vi.fn>>;
const attestationDb = prisma.complianceAttestation as unknown as Record<
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
});
