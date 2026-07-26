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
    site: {
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

// Cloudinary is mocked so the attachment-upload test never touches the network.
vi.mock('../../app/utils/cloudinary.js', () => ({
  default: vi.fn(),
}));

import { prisma } from '../../app/lib/prisma.js';
import { compliance_service } from '../../app/modules/compliance/compliance.service.js';
import { compliance_validations } from '../../app/modules/compliance/compliance.validation.js';
import uploadCloud from '../../app/utils/cloudinary.js';

const db = prisma.complianceObligation as unknown as Record<string, ReturnType<typeof vi.fn>>;
const siteDb = prisma.site as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const uploadCloudMock = uploadCloud as unknown as ReturnType<typeof vi.fn>;

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

describe('compliance service — org scoping (issue #93)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row — ADMIN-of-self fallback (org anchor ===
    // caller's own accountId), same convention every service test in this
    // suite uses.
    orgMemberDb.findUnique.mockResolvedValue(null);
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

    it('LEAD_AUDITOR can reassign line_of_defense', async () => {
      mockMembership('LEAD_AUDITOR');
      db.findFirst.mockResolvedValue({ id: 'c1', org_account_id: ANCHOR });
      db.update.mockResolvedValue({ id: 'c1', line_of_defense: 'FIRST' });

      await compliance_service.update_compliance_into_db(
        makeReq({ params: { id: 'c1' }, body: { line_of_defense: 'FIRST' } }),
      );

      const callArg = db.update.mock.calls[0][0];
      expect(callArg.data.line_of_defense).toBe('FIRST');
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
});
