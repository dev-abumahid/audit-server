import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    riskLink: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    risk: {
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
import { risk_link_service } from '../../app/modules/risk_link/risk_link.service.js';

const linkDb = prisma.riskLink as unknown as Record<string, ReturnType<typeof vi.fn>>;
const riskDb = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('risk_link_service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row -- ADMIN-of-self fallback, same convention
    // as every other org-scoped service test in this repo.
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  const mockMembership = (role: 'ADMIN' | 'LEAD_AUDITOR' | 'LIGHT_USER' | 'VIEWER') => {
    orgMemberDb.findUnique.mockResolvedValue({
      id: 'member-1',
      organizationId: 'org-1',
      accountId: ORG_A,
      role,
      status: 'ACTIVE',
      expiresAt: null,
    });
    organizationDb.findUnique.mockResolvedValue({ id: 'org-1', anchorAccountId: ORG_A });
  };

  describe('create_risk_link_into_db', () => {
    it('creates a link once both refs resolve to real, org-scoped risks', async () => {
      riskDb.findFirst.mockResolvedValue({ id: 'risk-1', review_status: 'APPROVED' });
      linkDb.create.mockResolvedValue({
        id: 'link-1',
        org_account_id: ORG_A,
        source_ref: 'CYB-001',
        target_ref: 'OPS-002',
        link_type: 'CAUSES',
      });

      const result = await risk_link_service.create_risk_link_into_db(
        makeReq({ body: { source_ref: 'CYB-001', target_ref: 'OPS-002', link_type: 'CAUSES' } }),
      );

      expect(riskDb.findFirst).toHaveBeenCalledWith({
        where: { org_account_id: ORG_A, ref: 'CYB-001' },
        select: { id: true, review_status: true },
      });
      expect(riskDb.findFirst).toHaveBeenCalledWith({
        where: { org_account_id: ORG_A, ref: 'OPS-002' },
        select: { id: true, review_status: true },
      });
      expect(linkDb.create).toHaveBeenCalledWith({
        data: {
          org_account_id: ORG_A,
          source_ref: 'CYB-001',
          target_ref: 'OPS-002',
          link_type: 'CAUSES',
        },
      });
      expect(result.id).toBe('link-1');
    });

    // docs/design-docs/ai-risk-review-approval-workflow.md, open item 1
    it('409s when a ref resolves to a DISMISSED risk', async () => {
      riskDb.findFirst.mockResolvedValue({ id: 'risk-1', review_status: 'DISMISSED' });

      await expect(
        risk_link_service.create_risk_link_into_db(
          makeReq({ body: { source_ref: 'CYB-001', target_ref: 'OPS-002', link_type: 'CAUSES' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(linkDb.create).not.toHaveBeenCalled();
    });

    it('allows linking to a PENDING_REVIEW risk (unreviewed, but not rejected)', async () => {
      riskDb.findFirst.mockResolvedValue({ id: 'risk-1', review_status: 'PENDING_REVIEW' });
      linkDb.create.mockResolvedValue({
        id: 'link-1',
        org_account_id: ORG_A,
        source_ref: 'CYB-001',
        target_ref: 'OPS-002',
        link_type: 'CAUSES',
      });

      const result = await risk_link_service.create_risk_link_into_db(
        makeReq({ body: { source_ref: 'CYB-001', target_ref: 'OPS-002', link_type: 'CAUSES' } }),
      );

      expect(result.id).toBe('link-1');
    });

    // Review fix: the new @@unique([org_account_id, source_ref, target_ref,
    // link_type]) constraint means a duplicate link now throws P2002 --
    // surfaced as a clean 409, not an unhandled 500.
    it('returns a 409 when the exact same link already exists', async () => {
      riskDb.findFirst.mockResolvedValue({ id: 'risk-1', review_status: 'APPROVED' });
      linkDb.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['org_account_id', 'source_ref', 'target_ref', 'link_type'] },
        }),
      );

      await expect(
        risk_link_service.create_risk_link_into_db(
          makeReq({ body: { source_ref: 'CYB-001', target_ref: 'OPS-002', link_type: 'CAUSES' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('propagates a non-conflict error from link creation unchanged', async () => {
      riskDb.findFirst.mockResolvedValue({ id: 'risk-1', review_status: 'APPROVED' });
      linkDb.create.mockRejectedValue(new Error('db connection lost'));

      await expect(
        risk_link_service.create_risk_link_into_db(
          makeReq({ body: { source_ref: 'CYB-001', target_ref: 'OPS-002', link_type: 'CAUSES' } }),
        ),
      ).rejects.toThrow('db connection lost');
    });

    it('404s when source_ref does not resolve to a risk in the caller org', async () => {
      riskDb.findFirst.mockResolvedValue(null);

      await expect(
        risk_link_service.create_risk_link_into_db(
          makeReq({ body: { source_ref: 'NOPE-001', target_ref: 'OPS-002', link_type: 'CAUSES' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(linkDb.create).not.toHaveBeenCalled();
    });

    it('404s when target_ref belongs to a different org (cross-org reference rejected)', async () => {
      // source resolves, target does not (simulating it belonging to org B)
      riskDb.findFirst.mockResolvedValueOnce({ id: 'risk-1' }).mockResolvedValueOnce(null);

      await expect(
        risk_link_service.create_risk_link_into_db(
          makeReq({
            body: { source_ref: 'CYB-001', target_ref: 'ORG-B-RISK', link_type: 'CAUSES' },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(linkDb.create).not.toHaveBeenCalled();
    });

    it('rejects a self-referencing link with 400', async () => {
      await expect(
        risk_link_service.create_risk_link_into_db(
          makeReq({ body: { source_ref: 'CYB-001', target_ref: 'CYB-001', link_type: 'CAUSES' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(riskDb.findFirst).not.toHaveBeenCalled();
      expect(linkDb.create).not.toHaveBeenCalled();
    });

    it('VIEWER cannot create a risk link', async () => {
      mockMembership('VIEWER');

      await expect(
        risk_link_service.create_risk_link_into_db(
          makeReq({ body: { source_ref: 'CYB-001', target_ref: 'OPS-002', link_type: 'CAUSES' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(linkDb.create).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR can create a risk link', async () => {
      mockMembership('LEAD_AUDITOR');
      riskDb.findFirst.mockResolvedValue({ id: 'risk-1', review_status: 'APPROVED' });
      linkDb.create.mockResolvedValue({ id: 'link-1' });

      await risk_link_service.create_risk_link_into_db(
        makeReq({
          user: { accountId: ORG_A },
          body: { source_ref: 'CYB-001', target_ref: 'OPS-002', link_type: 'CAUSES' },
        }),
      );

      expect(linkDb.create).toHaveBeenCalled();
    });
  });

  describe('get_all_risk_links_from_db', () => {
    it('scopes to the caller org and applies optional source_ref/target_ref filters', async () => {
      linkDb.findMany.mockResolvedValue([]);
      linkDb.count.mockResolvedValue(0);

      await risk_link_service.get_all_risk_links_from_db(
        makeReq({ query: { source_ref: 'CYB-001' } }),
      );

      expect(linkDb.findMany).toHaveBeenCalledWith({
        where: { org_account_id: ORG_A, source_ref: 'CYB-001' },
        skip: 0,
        take: 10,
        orderBy: { createdAt: 'desc' },
      });
      expect(linkDb.count).toHaveBeenCalledWith({
        where: { org_account_id: ORG_A, source_ref: 'CYB-001' },
      });
    });

    it('lists all org links when no filter is given', async () => {
      linkDb.findMany.mockResolvedValue([]);
      linkDb.count.mockResolvedValue(0);

      await risk_link_service.get_all_risk_links_from_db(makeReq({}));

      expect(linkDb.findMany).toHaveBeenCalledWith({
        where: { org_account_id: ORG_A },
        skip: 0,
        take: 10,
        orderBy: { createdAt: 'desc' },
      });
    });

    // aexa-server#271: was an unconditional findMany with no limit, unlike
    // every other list endpoint in this codebase.
    it('paginates via page/limit query params and returns {data, meta}', async () => {
      const links = [{ id: 'link-1' }, { id: 'link-2' }];
      linkDb.findMany.mockResolvedValue(links);
      linkDb.count.mockResolvedValue(25);

      const result = await risk_link_service.get_all_risk_links_from_db(
        makeReq({ query: { page: '2', limit: '5' } }),
      );

      expect(linkDb.findMany).toHaveBeenCalledWith({
        where: { org_account_id: ORG_A },
        skip: 5,
        take: 5,
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toEqual({
        data: links,
        meta: expect.objectContaining({ page: 2, limit: 5, total: 25, totalPage: 5 }),
      });
    });

    it('caps an oversized limit at the shared MAX_LIMIT ceiling (issue #117)', async () => {
      linkDb.findMany.mockResolvedValue([]);
      linkDb.count.mockResolvedValue(0);

      await risk_link_service.get_all_risk_links_from_db(makeReq({ query: { limit: '99999' } }));

      expect(linkDb.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    });
  });

  describe('delete_risk_link_from_db', () => {
    it('deletes a link that belongs to the caller org', async () => {
      linkDb.findFirst.mockResolvedValue({ id: 'link-1', org_account_id: ORG_A });
      linkDb.delete.mockResolvedValue({ id: 'link-1' });

      await risk_link_service.delete_risk_link_from_db(makeReq({ params: { id: 'link-1' } }));

      expect(linkDb.delete).toHaveBeenCalledWith({ where: { id: 'link-1' } });
    });

    it('404s deleting a link belonging to another org', async () => {
      linkDb.findFirst.mockResolvedValue(null);

      await expect(
        risk_link_service.delete_risk_link_from_db(makeReq({ params: { id: 'org-b-link' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(linkDb.delete).not.toHaveBeenCalled();
    });

    it('VIEWER cannot delete a risk link', async () => {
      mockMembership('VIEWER');

      await expect(
        risk_link_service.delete_risk_link_from_db(makeReq({ params: { id: 'link-1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(linkDb.findFirst).not.toHaveBeenCalled();
    });
  });
});
