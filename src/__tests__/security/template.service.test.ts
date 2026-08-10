import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    template: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
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
    inspection: {
      count: vi.fn(),
    },
    questionAnswer: {
      count: vi.fn(),
    },
    action: {
      count: vi.fn(),
    },
    orgMember: {
      findUnique: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
    profile: {
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
const profileDb = (prisma as unknown as { profile: Record<string, ReturnType<typeof vi.fn>> })
  .profile;
const inspectionDb = (prisma as unknown as { inspection: Record<string, ReturnType<typeof vi.fn>> })
  .inspection;
const questionAnswerDb = (
  prisma as unknown as { questionAnswer: Record<string, ReturnType<typeof vi.fn>> }
).questionAnswer;
const actionDb = (prisma as unknown as { action: Record<string, ReturnType<typeof vi.fn>> }).action;

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
    // Default target profile resolves to the caller's own account — i.e.
    // "same org" under the ADMIN-of-self fallback every test in this file
    // otherwise expects. Tests exercising the cross-org userId case (issue
    // #58) override this explicitly.
    profileDb.findUnique.mockResolvedValue({ accountId: ORG_A });
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

    it('throws 404 and does NOT grant access when the target userId belongs to another org (issue #58)', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      profileDb.findUnique.mockResolvedValue({ accountId: 'org-b-account' });

      await expect(
        template_service.add_template_access_member_into_db(
          makeReq({ body: { templateId: 't1', userId: 'org-b-profile' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(templateAccessDb.create).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT grant access when the target userId does not exist', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      profileDb.findUnique.mockResolvedValue(null);

      await expect(
        template_service.add_template_access_member_into_db(
          makeReq({ body: { templateId: 't1', userId: 'nonexistent-profile' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(templateAccessDb.create).not.toHaveBeenCalled();
    });

    it('grants access when the target resolves to the caller org via a REAL OrgMember row, not just the ADMIN-of-self fallback (issue #58 follow-up)', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      profileDb.findUnique.mockResolvedValue({ accountId: 'target-account' });
      // Caller has no OrgMember row (ADMIN-of-self, anchor = ORG_A); target
      // has a REAL, active OrgMember row whose org's anchor is also ORG_A —
      // two different resolution paths landing on the same anchor.
      orgMemberDb.findUnique.mockImplementation(({ where }: { where: { accountId: string } }) =>
        Promise.resolve(
          where.accountId === 'target-account'
            ? {
                id: 'om-1',
                organizationId: ORG_ID,
                accountId: 'target-account',
                role: 'LIGHT_USER',
                status: 'ACTIVE',
                expiresAt: null,
              }
            : null,
        ),
      );
      organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ORG_A });
      templateAccessDb.create.mockResolvedValue({});

      await template_service.add_template_access_member_into_db(
        makeReq({ body: { templateId: 't1', userId: 'target-profile' } }),
      );

      expect(templateAccessDb.create).toHaveBeenCalled();
    });

    it('throws 400 and does NOT grant access to a SUSPENDED target, even in the same org (issue #58 follow-up)', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      profileDb.findUnique.mockResolvedValue({ accountId: 'suspended-account' });
      // mockImplementation, not a blanket mockResolvedValue — orgMember.findUnique
      // is also called for the CALLER's own resolveCallerOrgContext above, and a
      // blanket suspended row there would 403 the caller before this test's
      // scenario (the *target* being suspended) is ever reached.
      orgMemberDb.findUnique.mockImplementation(({ where }: { where: { accountId: string } }) =>
        Promise.resolve(
          where.accountId === 'suspended-account'
            ? {
                id: 'om-1',
                organizationId: ORG_ID,
                accountId: 'suspended-account',
                role: 'LIGHT_USER',
                status: 'SUSPENDED',
                expiresAt: null,
              }
            : null,
        ),
      );
      organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ORG_A });

      await expect(
        template_service.add_template_access_member_into_db(
          makeReq({ body: { templateId: 't1', userId: 'suspended-profile' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });

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

    it('throws 404 and does NOT remove access when the target userId belongs to another org (issue #58)', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      profileDb.findUnique.mockResolvedValue({ accountId: 'org-b-account' });

      await expect(
        template_service.remove_template_access_member_from_db(
          makeReq({ body: { templateId: 't1', userId: 'org-b-profile' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(templateAccessDb.deleteMany).not.toHaveBeenCalled();
    });

    it('still revokes access from a SUSPENDED same-org target — offboarding must not be blocked (issue #58 follow-up)', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      profileDb.findUnique.mockResolvedValue({ accountId: 'suspended-account' });
      // mockImplementation, not a blanket mockResolvedValue — see the analogous
      // add_template_access_member_into_db test above for why.
      orgMemberDb.findUnique.mockImplementation(({ where }: { where: { accountId: string } }) =>
        Promise.resolve(
          where.accountId === 'suspended-account'
            ? {
                id: 'om-1',
                organizationId: ORG_ID,
                accountId: 'suspended-account',
                role: 'LIGHT_USER',
                status: 'SUSPENDED',
                expiresAt: null,
              }
            : null,
        ),
      );
      organizationDb.findUnique.mockResolvedValue({ id: ORG_ID, anchorAccountId: ORG_A });
      templateAccessDb.deleteMany.mockResolvedValue({ count: 1 });

      await template_service.remove_template_access_member_from_db(
        makeReq({ body: { templateId: 't1', userId: 'suspended-profile' } }),
      );

      expect(templateAccessDb.deleteMany).toHaveBeenCalled();
    });
  });
});

describe('template service — get_all_template_from_db pagination (ticket #116)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  // Qiyrix/aexa-server#116 — meta (via buildPaginationMeta) was missing
  // totalPage, unlike action/inspection/risk. Now built via the shared
  // paginationHelper/buildPaginationMeta pair, same as those endpoints.
  it('includes totalPage in meta, computed via the shared pagination helper', async () => {
    templateDb.findMany.mockResolvedValue([]);
    templateDb.count.mockResolvedValue(23);

    const result = await template_service.get_all_template_from_db(
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
    templateDb.findMany.mockResolvedValue([]);
    templateDb.count.mockResolvedValue(0);

    const result = await template_service.get_all_template_from_db(makeReq({ query: {} }));

    expect(result.meta).toEqual({
      page: 1,
      limit: 10,
      skip: 0,
      total: 0,
      totalPage: 0,
    });
  });

  // quality-bar-loop round 4 (Templates, industry-standards): category
  // filter, same optional-query-param shape as searchTerm above.
  it('filters by an exact category match when the category query param is given', async () => {
    templateDb.findMany.mockResolvedValue([]);
    templateDb.count.mockResolvedValue(0);

    await template_service.get_all_template_from_db(makeReq({ query: { category: 'Safety' } }));

    expect(templateDb.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ category: 'Safety' }),
      }),
    );
  });

  it('does not add a category filter when the query param is missing or blank', async () => {
    templateDb.findMany.mockResolvedValue([]);
    templateDb.count.mockResolvedValue(0);

    await template_service.get_all_template_from_db(makeReq({ query: { category: '  ' } }));

    const callArg = templateDb.findMany.mock.calls[0][0];
    expect(callArg.where).not.toHaveProperty('category');
  });

  // quality-bar-loop round 5 (Templates, industry-standards): draft/
  // publish status filter, so StartInspectionModal's template picker can
  // exclude drafts.
  it('filters by status=PUBLISHED when given', async () => {
    templateDb.findMany.mockResolvedValue([]);
    templateDb.count.mockResolvedValue(0);

    await template_service.get_all_template_from_db(makeReq({ query: { status: 'PUBLISHED' } }));

    expect(templateDb.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PUBLISHED' }),
      }),
    );
  });

  it('filters by status=DRAFT when given', async () => {
    templateDb.findMany.mockResolvedValue([]);
    templateDb.count.mockResolvedValue(0);

    await template_service.get_all_template_from_db(makeReq({ query: { status: 'DRAFT' } }));

    expect(templateDb.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'DRAFT' }),
      }),
    );
  });

  it('ignores an invalid status value rather than passing it through to Prisma', async () => {
    templateDb.findMany.mockResolvedValue([]);
    templateDb.count.mockResolvedValue(0);

    await template_service.get_all_template_from_db(
      makeReq({ query: { status: 'NOT_A_REAL_STATUS' } }),
    );

    const callArg = templateDb.findMany.mock.calls[0][0];
    expect(callArg.where).not.toHaveProperty('status');
  });

  it('does not add a status filter when the query param is missing', async () => {
    templateDb.findMany.mockResolvedValue([]);
    templateDb.count.mockResolvedValue(0);

    await template_service.get_all_template_from_db(makeReq({ query: {} }));

    const callArg = templateDb.findMany.mock.calls[0][0];
    expect(callArg.where).not.toHaveProperty('status');
  });
});

describe('template service — get_template_categories_from_db (quality-bar-loop round 4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  it('returns the distinct, non-null category values scoped to the caller org', async () => {
    templateDb.findMany.mockResolvedValue([{ category: 'Safety' }, { category: 'Quality' }]);

    const result = await template_service.get_template_categories_from_db(makeReq({ query: {} }));

    expect(templateDb.findMany).toHaveBeenCalledWith({
      where: { orgAccountId: ORG_A, category: { not: null } },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    });
    expect(result).toEqual(['Safety', 'Quality']);
  });

  it('returns an empty array when the org has no categorized templates', async () => {
    templateDb.findMany.mockResolvedValue([]);

    const result = await template_service.get_template_categories_from_db(makeReq({ query: {} }));

    expect(result).toEqual([]);
  });
});

describe('template service — write/access-grant role scoping (issue #55 slice 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
    // Default target profile resolves to the caller's own account — i.e.
    // "same org" under the ADMIN-of-self fallback every test in this file
    // otherwise expects. Tests exercising the cross-org userId case (issue
    // #58) override this explicitly.
    profileDb.findUnique.mockResolvedValue({ accountId: ORG_A });
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
    templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ANCHOR });
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
    // Default target profile resolves to the caller's own account — i.e.
    // "same org" under the ADMIN-of-self fallback every test in this file
    // otherwise expects. Tests exercising the cross-org userId case (issue
    // #58) override this explicitly.
    profileDb.findUnique.mockResolvedValue({ accountId: ORG_A });
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
    // Default target profile resolves to the caller's own account — i.e.
    // "same org" under the ADMIN-of-self fallback every test in this file
    // otherwise expects. Tests exercising the cross-org userId case (issue
    // #58) override this explicitly.
    profileDb.findUnique.mockResolvedValue({ accountId: ORG_A });
    // Default: nothing references the template/question, so the in-use delete
    // guards are no-ops unless a specific test overrides these counts.
    inspectionDb.count.mockResolvedValue(0);
    questionAnswerDb.count.mockResolvedValue(0);
    actionDb.count.mockResolvedValue(0);
  });

  it('get_single_template_from_db throws 404 for another org template instead of returning null', async () => {
    templateDb.findFirst.mockResolvedValue(null);

    await expect(
      template_service.get_single_template_from_db(makeReq({ params: { id: 'org-b-template' } })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('update_template_into_db verifies existence before updating (issue #60)', async () => {
    templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
    templateDb.update.mockResolvedValue({});

    await template_service.update_template_into_db(
      makeReq({ params: { id: 't1' }, body: { templateName: 'New name' } }),
    );

    expect(templateDb.findFirst).toHaveBeenCalledWith({
      where: { id: 't1', orgAccountId: ORG_A },
    });
    expect(templateDb.update).toHaveBeenCalled();
  });

  it('update_template_into_db throws 404 and does NOT update another org template (issue #60)', async () => {
    templateDb.findFirst.mockResolvedValue(null);

    await expect(
      template_service.update_template_into_db(
        makeReq({ params: { id: 'org-b-template' }, body: { templateName: 'hack' } }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(templateDb.update).not.toHaveBeenCalled();
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

describe('template service — duplicate_template_into_db (aexa-frontend quality-bar-loop, industry-standards: cloning parity with SafetyCulture/Typeform/Google Forms)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  const sourceTemplate = {
    id: 't1',
    orgAccountId: ORG_A,
    templateLogo: 'https://cdn.example.com/logo.png',
    templateName: 'ISO 27001 Audit',
    templateDisc: 'Standard checklist',
    category: 'Safety',
    pages: [
      {
        id: 'p1',
        pageIndex: 0,
        title: 'Section 1',
        questions: [
          {
            id: 'q1',
            index: 0,
            question: 'Is the door locked?',
            isRequired: true,
            answerType: 'checkbox',
            // Prisma's JsonValue read type allows a literal JSON `null` for
            // a required Json column -- the write side needs the explicit
            // Prisma.JsonNull sentinel to represent that, not JS `null`
            // (which Prisma treats as "field omitted"). This source row
            // exercises that path.
            value: null,
          },
        ],
      },
    ],
  };

  it('throws 404 and does NOT create anything for another org template', async () => {
    templateDb.findFirst.mockResolvedValue(null);

    await expect(
      template_service.duplicate_template_into_db(makeReq({ params: { id: 'org-b-template' } })),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(templateDb.create).not.toHaveBeenCalled();
  });

  it('VIEWER cannot duplicate a template', async () => {
    mockMembership('VIEWER');

    await expect(
      template_service.duplicate_template_into_db(makeReq({ params: { id: 't1' } })),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(templateDb.findFirst).not.toHaveBeenCalled();
    expect(templateDb.create).not.toHaveBeenCalled();
  });

  it('copies name (suffixed), logo, description, and every page/question, scoped to the caller org', async () => {
    templateDb.findFirst.mockResolvedValue(sourceTemplate);
    templateDb.create.mockResolvedValue({ id: 't2' });

    await template_service.duplicate_template_into_db(makeReq({ params: { id: 't1' } }));

    expect(templateDb.findFirst).toHaveBeenCalledWith({
      where: { id: 't1', orgAccountId: ORG_A },
      include: { pages: { include: { questions: true } } },
    });
    const callArg = templateDb.create.mock.calls[0][0];
    expect(callArg.data.orgAccountId).toBe(ORG_A);
    expect(callArg.data.templateName).toBe('ISO 27001 Audit (copy)');
    expect(callArg.data.templateLogo).toBe('https://cdn.example.com/logo.png');
    expect(callArg.data.templateDisc).toBe('Standard checklist');
    expect(callArg.data.category).toBe('Safety');
    expect(callArg.data.status).toBe('DRAFT');
    expect(callArg.data.pages.create).toEqual([
      {
        pageIndex: 0,
        title: 'Section 1',
        questions: {
          create: [
            {
              index: 0,
              question: 'Is the door locked?',
              isRequired: true,
              answerType: 'checkbox',
              value: Prisma.JsonNull,
            },
          ],
        },
      },
    ]);
  });

  // A duplicate is a fresh, private draft -- matching create_template_into_db,
  // which never populates `access` on creation either. Copying the original's
  // sharing grants would leak them to a template the copy's creator may not
  // want shared yet.
  it('does not copy the source template access grants onto the duplicate', async () => {
    templateDb.findFirst.mockResolvedValue({
      ...sourceTemplate,
      access: [{ userId: 'someone-else' }],
    });
    templateDb.create.mockResolvedValue({ id: 't2' });

    await template_service.duplicate_template_into_db(makeReq({ params: { id: 't1' } }));

    const callArg = templateDb.create.mock.calls[0][0];
    expect(callArg.data.access).toBeUndefined();
  });

  // quality-bar-loop round 5 follow-up: a copy of a published template
  // hasn't itself been reviewed, so it starts DRAFT regardless of the
  // source's own status -- same rationale as not copying access grants.
  it('always creates the duplicate as DRAFT, even when the source is PUBLISHED', async () => {
    templateDb.findFirst.mockResolvedValue({ ...sourceTemplate, status: 'PUBLISHED' });
    templateDb.create.mockResolvedValue({ id: 't2' });

    await template_service.duplicate_template_into_db(makeReq({ params: { id: 't1' } }));

    const callArg = templateDb.create.mock.calls[0][0];
    expect(callArg.data.status).toBe('DRAFT');
  });

  it('duplicates a template with no pages without throwing', async () => {
    templateDb.findFirst.mockResolvedValue({ ...sourceTemplate, pages: [] });
    templateDb.create.mockResolvedValue({ id: 't2' });

    await template_service.duplicate_template_into_db(makeReq({ params: { id: 't1' } }));

    const callArg = templateDb.create.mock.calls[0][0];
    expect(callArg.data.pages.create).toEqual([]);
  });
});

describe('template service — in-use delete guards (found by audit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgMemberDb.findUnique.mockResolvedValue(null);
    inspectionDb.count.mockResolvedValue(0);
    questionAnswerDb.count.mockResolvedValue(0);
    actionDb.count.mockResolvedValue(0);
  });

  describe('delete_template_from_db', () => {
    // Inspection.template is onDelete: Cascade, so deleting an in-use template
    // would silently destroy its inspections. The guard blocks with a 409.
    it('throws 409 and does NOT delete a template still referenced by an inspection', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      inspectionDb.count.mockResolvedValue(4);

      await expect(
        template_service.delete_template_from_db(makeReq({ params: { id: 't1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(inspectionDb.count).toHaveBeenCalledWith({ where: { templateId: 't1' } });
      expect(templateDb.delete).not.toHaveBeenCalled();
    });

    it('deletes a template when no inspection references it', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      inspectionDb.count.mockResolvedValue(0);
      templateDb.delete.mockResolvedValue({ id: 't1' });

      await template_service.delete_template_from_db(makeReq({ params: { id: 't1' } }));

      expect(templateDb.delete).toHaveBeenCalledWith({
        where: { id: 't1', orgAccountId: ORG_A },
      });
    });
  });

  describe('delete_template_page_by_id_from_db', () => {
    const ownedPage = { template: { orgAccountId: ORG_A } };

    // Deleting a Page cascade-deletes its Questions, which cascade-delete
    // QuestionAnswers and Actions — the same hazard the question-level guard
    // blocks, bypassable one level up without this guard (audit follow-up).
    it('throws 409 and does NOT delete a page whose questions have answers', async () => {
      pageDb.findFirst.mockResolvedValue(ownedPage);
      questionAnswerDb.count.mockResolvedValue(3);
      actionDb.count.mockResolvedValue(0);

      await expect(
        template_service.delete_template_page_by_id_from_db(makeReq({ params: { id: 'p1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(questionAnswerDb.count).toHaveBeenCalledWith({
        where: { question: { pageId: 'p1' } },
      });
      expect(pageDb.delete).not.toHaveBeenCalled();
    });

    it('throws 409 and does NOT delete a page whose questions have actions', async () => {
      pageDb.findFirst.mockResolvedValue(ownedPage);
      questionAnswerDb.count.mockResolvedValue(0);
      actionDb.count.mockResolvedValue(1);

      await expect(
        template_service.delete_template_page_by_id_from_db(makeReq({ params: { id: 'p1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(actionDb.count).toHaveBeenCalledWith({ where: { question: { pageId: 'p1' } } });
      expect(pageDb.delete).not.toHaveBeenCalled();
    });

    it('deletes a page when none of its questions have answers or actions', async () => {
      pageDb.findFirst.mockResolvedValue(ownedPage);
      questionAnswerDb.count.mockResolvedValue(0);
      actionDb.count.mockResolvedValue(0);
      pageDb.delete.mockResolvedValue({ id: 'p1' });

      await template_service.delete_template_page_by_id_from_db(makeReq({ params: { id: 'p1' } }));

      expect(pageDb.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
    });
  });

  describe('delete_page_question_by_id_from_db', () => {
    const ownedQuestion = {
      page: { template: { orgAccountId: ORG_A } },
    };

    // QuestionAnswer.question and Action.question are both onDelete: Cascade,
    // so deleting an answered/actioned question would silently destroy those
    // records. The guard blocks with a 409.
    it('throws 409 and does NOT delete a question that already has answers', async () => {
      questionDb.findFirst.mockResolvedValue(ownedQuestion);
      questionAnswerDb.count.mockResolvedValue(5);
      actionDb.count.mockResolvedValue(0);

      await expect(
        template_service.delete_page_question_by_id_from_db(makeReq({ params: { id: 'q1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(questionDb.delete).not.toHaveBeenCalled();
    });

    it('throws 409 and does NOT delete a question that an action references', async () => {
      questionDb.findFirst.mockResolvedValue(ownedQuestion);
      questionAnswerDb.count.mockResolvedValue(0);
      actionDb.count.mockResolvedValue(2);

      await expect(
        template_service.delete_page_question_by_id_from_db(makeReq({ params: { id: 'q1' } })),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(questionDb.delete).not.toHaveBeenCalled();
    });

    it('deletes a question when it has no answers and no actions', async () => {
      questionDb.findFirst.mockResolvedValue(ownedQuestion);
      questionAnswerDb.count.mockResolvedValue(0);
      actionDb.count.mockResolvedValue(0);
      questionDb.delete.mockResolvedValue({ id: 'q1' });

      await template_service.delete_page_question_by_id_from_db(makeReq({ params: { id: 'q1' } }));

      expect(questionDb.delete).toHaveBeenCalledWith({ where: { id: 'q1' } });
    });
  });
});
