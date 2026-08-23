import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    supplier: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    organizationProfile: {
      findUnique: vi.fn(),
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
import { supplier_service } from '../../app/modules/supplier/supplier.service.js';

const db = prisma.supplier as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgProfileDb = prisma.organizationProfile as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
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

function mockAiResponse(ok: boolean, status = 502, body: unknown = {}) {
  return { ok, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

describe('supplier service — org scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  describe('write-path role scoping', () => {
    it('VIEWER cannot create a supplier', async () => {
      mockMembership('VIEWER');

      await expect(
        supplier_service.create_supplier_into_db(makeReq({ body: { name: 'Acme Steel' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('LIGHT_USER cannot update a supplier', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        supplier_service.update_supplier_into_db(
          makeReq({ params: { id: 's1' }, body: { name: 'hack' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.findFirst).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it('VIEWER cannot delete a supplier', async () => {
      mockMembership('VIEWER');

      await expect(
        supplier_service.delete_supplier_from_db(makeReq({ params: { id: 's1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.delete).not.toHaveBeenCalled();
    });

    it('VIEWER cannot trigger AI supplier discovery', async () => {
      mockMembership('VIEWER');

      await expect(
        supplier_service.discover_suppliers_for_org(makeReq({ body: {} })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(fetch).not.toHaveBeenCalled();
    });

    it('LIGHT_USER cannot trigger AI supplier discovery', async () => {
      mockMembership('LIGHT_USER');

      await expect(
        supplier_service.discover_suppliers_for_org(makeReq({ body: {} })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(fetch).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR (a writer role) can still create a supplier', async () => {
      mockMembership('LEAD_AUDITOR');
      db.create.mockResolvedValue({});

      await supplier_service.create_supplier_into_db(makeReq({ body: { name: 'Acme Steel' } }));

      expect(db.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: 'Acme Steel', org_account_id: ANCHOR }),
      });
    });
  });

  describe('cross-tenant / not-found scoping', () => {
    it('get_single_supplier_from_db 404s when the supplier belongs to another org', async () => {
      db.findUnique.mockResolvedValue(null);

      await expect(
        supplier_service.get_single_supplier_from_db(makeReq({ params: { id: 's1' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('update_supplier_into_db 404s for a cross-org id without ever calling update', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        supplier_service.update_supplier_into_db(
          makeReq({ params: { id: 's1' }, body: { name: 'x' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('update_supplier_into_db never trusts an org_account_id in the request body', async () => {
      db.findFirst.mockResolvedValue({ id: 's1', org_account_id: ANCHOR });
      db.update.mockResolvedValue({});

      await supplier_service.update_supplier_into_db(
        makeReq({ params: { id: 's1' }, body: { name: 'x', org_account_id: 'someone-elses-org' } }),
      );

      expect(db.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: expect.objectContaining({ name: 'x', org_account_id: ANCHOR }),
      });
    });

    it('delete_supplier_from_db 404s for a cross-org id without ever calling delete', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        supplier_service.delete_supplier_from_db(makeReq({ params: { id: 's1' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe('discover_suppliers_for_org (zero-input discovery, mirrors onboarding site discovery)', () => {
    it('LEAD_AUDITOR (a writer role) can trigger AI supplier discovery', async () => {
      mockMembership('LEAD_AUDITOR');
      orgProfileDb.findUnique.mockResolvedValue({ organizationName: 'Fives Nordon' });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockAiResponse(true, 200, { suppliers_information: [] }),
      );

      await supplier_service.discover_suppliers_for_org(makeReq({ body: {} }));

      expect(fetch).toHaveBeenCalled();
    });

    it('uses the org profile name when no explicit company_name is provided', async () => {
      orgProfileDb.findUnique.mockResolvedValue({ organizationName: 'Fives Nordon' });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockAiResponse(true, 200, { suppliers_information: [{ supplier_name: 'Acme Steel' }] }),
      );

      const result = await supplier_service.discover_suppliers_for_org(makeReq({ body: {} }));

      expect(orgProfileDb.findUnique).toHaveBeenCalledWith({
        where: { accountId: ANCHOR },
        select: { organizationName: true },
      });
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(init.body as string)).toEqual({ company_name: 'Fives Nordon' });
      expect(result).toEqual({ suppliers_information: [{ supplier_name: 'Acme Steel' }] });
    });

    it('uses an explicit company_name override without querying the org profile', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockAiResponse(true, 200, { suppliers_information: [] }),
      );

      await supplier_service.discover_suppliers_for_org(
        makeReq({ body: { company_name: 'A Different Brand Name' } }),
      );

      expect(orgProfileDb.findUnique).not.toHaveBeenCalled();
      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(init.body as string)).toEqual({ company_name: 'A Different Brand Name' });
    });

    it('throws a 400 when neither an override nor an org profile name is available', async () => {
      orgProfileDb.findUnique.mockResolvedValue(null);

      await expect(
        supplier_service.discover_suppliers_for_org(makeReq({ body: {} })),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(fetch).not.toHaveBeenCalled();
    });

    it('wraps an aborted (timed-out) aexa-ai call as a distinct 504, not the generic 500', async () => {
      // Same fix as compliance.service.ts's suggest_regulatory_sources_with_ai
      // -- the frontend's SupplierDiscoveryPanel already branches on
      // status === 504 to show a distinct "search timed out" toast, but
      // without this the AbortError from fetchWithTimeout's own timeout
      // fell into the generic wrapAiServiceError 500 path and that branch
      // could never actually fire.
      orgProfileDb.findUnique.mockResolvedValue({ organizationName: 'Fives Nordon' });
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(abortError);

      await expect(
        supplier_service.discover_suppliers_for_org(makeReq({ body: {} })),
      ).rejects.toMatchObject({ statusCode: 504, message: 'Supplier discovery timed out' });
    });

    it('throws a 502 AppError when the AI service responds with a non-ok status', async () => {
      orgProfileDb.findUnique.mockResolvedValue({ organizationName: 'Fives Nordon' });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockAiResponse(false, 503));

      await expect(
        supplier_service.discover_suppliers_for_org(makeReq({ body: {} })),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it('degrades a raw thrown error to a generic 500 rather than leaking internal detail', async () => {
      orgProfileDb.findUnique.mockRejectedValue(new Error('DB connection lost'));

      await expect(
        supplier_service.discover_suppliers_for_org(makeReq({ body: {} })),
      ).rejects.toMatchObject({ statusCode: 500, message: 'Failed to discover suppliers' });
    });
  });
});
