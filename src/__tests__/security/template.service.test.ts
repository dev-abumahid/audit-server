import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    template: {
      findFirst: vi.fn(),
    },
    templateAccess: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    orgMember: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { template_service } from '../../app/modules/template/template.service.js';

const templateDb = prisma.template as unknown as Record<string, ReturnType<typeof vi.fn>>;
const templateAccessDb = prisma.templateAccess as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('template service — access member ownership scoping (ticket #31)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row — ADMIN-of-self fallback (org anchor ===
    // caller's own accountId), same as every pre-org-scoping-migration test
    // in this file expects.
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  describe('add_template_access_member_into_db', () => {
    it('verifies template ownership before granting access', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      templateAccessDb.create.mockResolvedValue({});

      await template_service.add_template_access_member_into_db(
        makeReq({ body: { templateId: 't1', userId: 'u1' } }),
      );

      expect(templateDb.findFirst).toHaveBeenCalledWith({
        where: { id: 't1', orgAccountId: ORG_A },
      });
      expect(templateAccessDb.create).toHaveBeenCalled();
    });

    it('throws 404 and does NOT grant access when the template belongs to another org', async () => {
      templateDb.findFirst.mockResolvedValue(null);

      await expect(
        template_service.add_template_access_member_into_db(
          makeReq({ body: { templateId: 'org-b-template', userId: 'u1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(templateAccessDb.create).not.toHaveBeenCalled();
    });
  });

  describe('remove_template_access_member_from_db', () => {
    it('verifies template ownership before removing access', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      templateAccessDb.deleteMany.mockResolvedValue({ count: 1 });

      await template_service.remove_template_access_member_from_db(
        makeReq({ body: { templateId: 't1', userId: 'u1' } }),
      );

      expect(templateDb.findFirst).toHaveBeenCalledWith({
        where: { id: 't1', orgAccountId: ORG_A },
      });
      expect(templateAccessDb.deleteMany).toHaveBeenCalled();
    });

    it('throws 404 and does NOT remove access when the template belongs to another org', async () => {
      templateDb.findFirst.mockResolvedValue(null);

      await expect(
        template_service.remove_template_access_member_from_db(
          makeReq({ body: { templateId: 'org-b-template', userId: 'u1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(templateAccessDb.deleteMany).not.toHaveBeenCalled();
    });
  });
});

describe('template service — access invitation payload field name (ticket #57)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row — ADMIN-of-self fallback (org anchor ===
    // caller's own accountId), same as every pre-org-scoping-migration test
    // in this file expects.
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  it('passes the userId from the request body through to templateAccess.create, not undefined', async () => {
    templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
    templateAccessDb.create.mockResolvedValue({});

    await template_service.add_template_access_member_into_db(
      makeReq({ body: { templateId: 't1', userId: 'u1' } }),
    );

    expect(templateAccessDb.create).toHaveBeenCalledWith({
      data: {
        templateId: 't1',
        userId: 'u1',
      },
    });
  });

  it('passes a defined, non-undefined userId to templateAccess.deleteMany, not a blanket delete', async () => {
    templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
    templateAccessDb.deleteMany.mockResolvedValue({ count: 1 });

    await template_service.remove_template_access_member_from_db(
      makeReq({ body: { templateId: 't1', userId: 'u1' } }),
    );

    expect(templateAccessDb.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        templateId: 't1',
      },
    });
  });
});
