import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    template: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    templateAccess: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    page: {
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    question: {
      findFirst: vi.fn(),
      delete: vi.fn(),
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
import { template_service } from '../../app/modules/template/template.service.js';

const templateDb = prisma.template as unknown as Record<string, ReturnType<typeof vi.fn>>;
const templateAccessDb = prisma.templateAccess as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const pageDb = (prisma as unknown as { page: Record<string, ReturnType<typeof vi.fn>> }).page;
const questionDb = (prisma as unknown as { question: Record<string, ReturnType<typeof vi.fn>> })
  .question;

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

describe('template service — write/access-grant role scoping (issue #55 slice 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  it('VIEWER cannot create a template', async () => {
    mockMembership('VIEWER');

    await expect(
      template_service.create_template_into_db(
        makeReq({ body: { templateName: 'Fire audit', pages: [] } }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(templateDb.create).not.toHaveBeenCalled();
  });

  it('LIGHT_USER cannot update a template', async () => {
    mockMembership('LIGHT_USER');

    await expect(
      template_service.update_template_into_db(
        makeReq({ params: { id: 't1' }, body: { templateName: 'hack' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(templateDb.update).not.toHaveBeenCalled();
  });

  it('VIEWER cannot delete a template', async () => {
    mockMembership('VIEWER');

    await expect(
      template_service.delete_template_from_db(makeReq({ params: { id: 't1' } })),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(templateDb.delete).not.toHaveBeenCalled();
  });

  it('ignores an orgAccountId supplied in the body and always writes the caller org anchor on update', async () => {
    mockMembership('ADMIN');
    templateDb.update.mockResolvedValue({});

    await template_service.update_template_into_db(
      makeReq({
        params: { id: 't1' },
        body: { templateName: 'New name', orgAccountId: 'other-org' },
      }),
    );

    const callArg = templateDb.update.mock.calls[0][0];
    expect(callArg.data.orgAccountId).toBe(ANCHOR);
  });

  it('LIGHT_USER cannot grant template access (privilege-escalation gate)', async () => {
    mockMembership('LIGHT_USER');

    await expect(
      template_service.add_template_access_member_into_db(
        makeReq({ body: { templateId: 't1', userId: 'u1' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(templateDb.findFirst).not.toHaveBeenCalled();
    expect(templateAccessDb.create).not.toHaveBeenCalled();
  });

  it('LEAD_AUDITOR cannot revoke template access — grant/revoke is ADMIN-only, not the general write role gate', async () => {
    mockMembership('LEAD_AUDITOR');

    await expect(
      template_service.remove_template_access_member_from_db(
        makeReq({ body: { templateId: 't1', userId: 'u1' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(templateAccessDb.deleteMany).not.toHaveBeenCalled();
  });

  it('ADMIN can still grant template access (gate does not over-block)', async () => {
    mockMembership('ADMIN');
    templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ANCHOR });
    templateAccessDb.create.mockResolvedValue({});

    await template_service.add_template_access_member_into_db(
      makeReq({ body: { templateId: 't1', userId: 'u1' } }),
    );

    expect(templateAccessDb.create).toHaveBeenCalled();
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

describe('template service — error-handling consistency (issue #55 follow-up)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  it('get_single_template_from_db throws 404 for another org template instead of returning null', async () => {
    templateDb.findFirst.mockResolvedValue(null);

    await expect(
      template_service.get_single_template_from_db(makeReq({ params: { id: 'org-b-template' } })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('delete_template_from_db verifies existence before deleting', async () => {
    templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
    templateDb.delete.mockResolvedValue({});

    await template_service.delete_template_from_db(makeReq({ params: { id: 't1' } }));

    expect(templateDb.findFirst).toHaveBeenCalledWith({
      where: { id: 't1', orgAccountId: ORG_A },
    });
    expect(templateDb.delete).toHaveBeenCalledWith({
      where: { id: 't1', orgAccountId: ORG_A },
    });
  });

  it('delete_template_from_db throws 404 and does NOT delete another org template', async () => {
    templateDb.findFirst.mockResolvedValue(null);

    await expect(
      template_service.delete_template_from_db(makeReq({ params: { id: 'org-b-template' } })),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(templateDb.delete).not.toHaveBeenCalled();
  });

  it('delete_template_page_by_id_from_db throws an AppError(404), not a plain Error, for a cross-org page', async () => {
    pageDb.findFirst.mockResolvedValue(null);

    await expect(
      template_service.delete_template_page_by_id_from_db(
        makeReq({ params: { id: 'org-b-page' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(pageDb.delete).not.toHaveBeenCalled();
  });

  it('delete_page_question_by_id_from_db throws an AppError(404), not a plain Error, for a cross-org question', async () => {
    questionDb.findFirst.mockResolvedValue(null);

    await expect(
      template_service.delete_page_question_by_id_from_db(
        makeReq({ params: { id: 'org-b-question' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(questionDb.delete).not.toHaveBeenCalled();
  });
});
