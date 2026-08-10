import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

// setup.ts sets AI_INTERNAL_SECRET = 'test-ai-internal-secret' before any
// config import — the exact secret mintOrgToken signs the X-Org-Token with.
const jwtDecode = (token: string) => jwt.verify(token, 'test-ai-internal-secret') as jwt.JwtPayload;

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    inspection: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    template: {
      findFirst: vi.fn(),
    },
    site: {
      findFirst: vi.fn(),
    },
    note: {
      findUnique: vi.fn(),
    },
    questionAnswer: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    question: {
      count: vi.fn(),
    },
    orgMember: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
    profile: {
      findUnique: vi.fn(),
    },
    inspectionAssignment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    orgAuditLog: {
      create: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { inspection_service } from '../../app/modules/inspection/inspection.service.js';

const inspectionDb = prisma.inspection as unknown as Record<string, ReturnType<typeof vi.fn>>;
const noteDb = prisma.note as unknown as Record<string, ReturnType<typeof vi.fn>>;
const templateDb = prisma.template as unknown as Record<string, ReturnType<typeof vi.fn>>;
const siteDb = prisma.site as unknown as Record<string, ReturnType<typeof vi.fn>>;
const qaDb = prisma.questionAnswer as unknown as Record<string, ReturnType<typeof vi.fn>>;
const questionDb = prisma.question as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const assignmentDb = prisma.inspectionAssignment as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const profileDb = prisma.profile as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('inspection service — org scoping (ticket #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row — every pre-existing test in this file
    // predates slice 3's role scoping and expects the backward-compat
    // ADMIN-of-self fallback (org anchor === caller's own accountId, same
    // as the pre-slice-3 behavior).
    orgMemberDb.findUnique.mockResolvedValue(null);
    // Default: every pre-existing test in this file passes a plain
    // `inspectorProfileId: 'p1'` fixture without caring about the profile
    // org-ownership check added for issue #279 — resolve it to the caller's
    // own org (ORG_A) so those tests are unaffected. Tests that specifically
    // exercise the ownership check override this per case below.
    profileDb.findUnique.mockResolvedValue({ accountId: ORG_A });
  });

  describe('get_all_inspection_from_db', () => {
    it('filters by caller org', async () => {
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      const [countArg] = inspectionDb.count.mock.calls[0];
      expect(countArg.where).toMatchObject({ orgAccountId: ORG_A });

      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ orgAccountId: ORG_A });
    });

    // Issue #125: this endpoint hand-rolled `Number(page)`/`Number(limit)`
    // pagination instead of the shared paginationHelper/buildPaginationMeta,
    // so it never picked up the MAX_LIMIT cap.
    it('includes totalPage in meta, computed via the shared pagination helper', async () => {
      inspectionDb.findMany.mockResolvedValue([]);
      inspectionDb.count.mockResolvedValue(23);

      const result = await inspection_service.get_all_inspection_from_db(
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
      inspectionDb.findMany.mockResolvedValue([]);
      inspectionDb.count.mockResolvedValue(0);

      const result = await inspection_service.get_all_inspection_from_db(
        makeReq({ query: { page: '1', limit: '1000000' } }),
      );

      expect(result.meta.limit).toBe(100);
      const [callArg] = inspectionDb.findMany.mock.calls[0];
      expect(callArg.take).toBe(100);
    });

    it('defaults to page 1 / limit 10 when no query params are supplied', async () => {
      inspectionDb.findMany.mockResolvedValue([]);
      inspectionDb.count.mockResolvedValue(0);

      const result = await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      expect(result.meta).toEqual({
        page: 1,
        limit: 10,
        skip: 0,
        total: 0,
        totalPage: 0,
      });
    });
  });

  describe('get_single_inspection_from_db', () => {
    it('includes orgAccountId in WHERE clause', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'i1', orgAccountId: ORG_A });

      await inspection_service.get_single_inspection_from_db(makeReq({ params: { id: 'i1' } }));

      const [callArg] = inspectionDb.findFirst.mock.calls[0];
      expect(callArg.where).toMatchObject({ id: 'i1', orgAccountId: ORG_A });
    });

    it('throws 404 for another org inspection', async () => {
      inspectionDb.findFirst.mockResolvedValue(null);

      await expect(
        inspection_service.get_single_inspection_from_db(
          makeReq({ params: { id: 'org-b-inspection' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('create_inspection_into_db', () => {
    it('injects orgAccountId into the created record', async () => {
      templateDb.findFirst.mockResolvedValue({
        id: 't1',
        orgAccountId: ORG_A,
      });

      siteDb.findFirst.mockResolvedValue({
        id: 's1',
        org_account_id: ORG_A,
      });

      inspectionDb.create.mockResolvedValue({});

      await inspection_service.create_inspection_into_db(
        makeReq({
          body: {
            templateId: 't1',
            siteId: 's1',
            inspectorProfileId: 'p1',
            questionAnswers: [],
          },
        }),
      );

      const callArg = inspectionDb.create.mock.calls[0][0];
      expect(callArg.data.orgAccountId).toBe(ORG_A);
    });

    it('throws 404 and does NOT create when the templateId belongs to another org', async () => {
      templateDb.findFirst.mockResolvedValue(null);
      siteDb.findFirst.mockResolvedValue({ id: 's1', org_account_id: ORG_A });

      await expect(
        inspection_service.create_inspection_into_db(
          makeReq({
            body: {
              templateId: 'org-b-template',
              siteId: 's1',
              inspectorProfileId: 'p1',
              questionAnswers: [],
            },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(inspectionDb.create).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT create when the siteId belongs to another org', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      siteDb.findFirst.mockResolvedValue(null);

      await expect(
        inspection_service.create_inspection_into_db(
          makeReq({
            body: {
              templateId: 't1',
              siteId: 'org-b-site',
              inspectorProfileId: 'p1',
              questionAnswers: [],
            },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(inspectionDb.create).not.toHaveBeenCalled();
    });

    it('verifies every questionAnswers[].questionId belongs to the caller org before creating (issue #84)', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      siteDb.findFirst.mockResolvedValue({ id: 's1', org_account_id: ORG_A });
      questionDb.count.mockResolvedValue(2);
      inspectionDb.create.mockResolvedValue({});

      await inspection_service.create_inspection_into_db(
        makeReq({
          body: {
            templateId: 't1',
            siteId: 's1',
            inspectorProfileId: 'p1',
            questionAnswers: [
              { questionId: 'q1', answer: 'yes' },
              { questionId: 'q2', answer: 'no' },
            ],
          },
        }),
      );

      expect(questionDb.count).toHaveBeenCalledWith({
        where: { id: { in: ['q1', 'q2'] }, page: { template: { orgAccountId: ORG_A } } },
      });
      expect(inspectionDb.create).toHaveBeenCalled();
    });

    it('throws 404 and does NOT create when a questionId belongs to another org (issue #84)', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      siteDb.findFirst.mockResolvedValue({ id: 's1', org_account_id: ORG_A });
      // Only 1 of the 2 supplied questionIds actually resolves under the
      // caller's org — the other belongs to a different org's template.
      questionDb.count.mockResolvedValue(1);

      await expect(
        inspection_service.create_inspection_into_db(
          makeReq({
            body: {
              templateId: 't1',
              siteId: 's1',
              inspectorProfileId: 'p1',
              questionAnswers: [
                { questionId: 'q1', answer: 'yes' },
                { questionId: 'org-b-question', answer: 'no' },
              ],
            },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(inspectionDb.create).not.toHaveBeenCalled();
    });

    it('does NOT wrongly reject a legitimate request with a repeated questionId (issue #84 follow-up)', async () => {
      templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
      siteDb.findFirst.mockResolvedValue({ id: 's1', org_account_id: ORG_A });
      // Only one DISTINCT questionId is supplied (q1, twice) — count() only
      // ever sees 1 distinct matching row, so the check must compare against
      // the deduplicated id count, not the raw array length (2), or this
      // legitimate request would be wrongly rejected.
      questionDb.count.mockResolvedValue(1);
      inspectionDb.create.mockResolvedValue({});

      await inspection_service.create_inspection_into_db(
        makeReq({
          body: {
            templateId: 't1',
            siteId: 's1',
            inspectorProfileId: 'p1',
            questionAnswers: [
              { questionId: 'q1', answer: 'yes' },
              { questionId: 'q1', answer: 'edited' },
            ],
          },
        }),
      );

      expect(questionDb.count).toHaveBeenCalledWith({
        where: { id: { in: ['q1'] }, page: { template: { orgAccountId: ORG_A } } },
      });
      expect(inspectionDb.create).toHaveBeenCalled();
    });

    // Issue #279: inspectorProfileId was missing from the create_inspection
    // Zod schema entirely, so Zod's default unknown-key stripping
    // (request_validator.ts) silently dropped whatever the client sent and
    // the service always wrote `undefined` regardless of the request body.
    // These cover the service-level org-ownership guard added alongside the
    // schema fix.
    describe('inspectorProfileId org-ownership guard (issue #279)', () => {
      it('accepts a valid org-scoped inspectorProfileId and writes it to the created record', async () => {
        templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
        siteDb.findFirst.mockResolvedValue({ id: 's1', org_account_id: ORG_A });
        profileDb.findUnique.mockResolvedValue({ accountId: ORG_A });
        inspectionDb.create.mockResolvedValue({});

        await inspection_service.create_inspection_into_db(
          makeReq({
            body: {
              templateId: 't1',
              siteId: 's1',
              inspectorProfileId: 'profile-in-org-a',
              questionAnswers: [],
            },
          }),
        );

        expect(profileDb.findUnique).toHaveBeenCalledWith({
          where: { id: 'profile-in-org-a' },
          select: { accountId: true },
        });
        const callArg = inspectionDb.create.mock.calls[0][0];
        expect(callArg.data.inspectorProfileId).toBe('profile-in-org-a');
      });

      it('throws 404 and does NOT create when inspectorProfileId belongs to another org', async () => {
        templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
        siteDb.findFirst.mockResolvedValue({ id: 's1', org_account_id: ORG_A });
        // Target profile's own account resolves to a different org anchor.
        profileDb.findUnique.mockResolvedValue({ accountId: 'org-b-account' });

        await expect(
          inspection_service.create_inspection_into_db(
            makeReq({
              body: {
                templateId: 't1',
                siteId: 's1',
                inspectorProfileId: 'org-b-profile',
                questionAnswers: [],
              },
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 404 });

        expect(inspectionDb.create).not.toHaveBeenCalled();
      });

      it('throws 404 and does NOT create when inspectorProfileId does not exist at all', async () => {
        templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
        siteDb.findFirst.mockResolvedValue({ id: 's1', org_account_id: ORG_A });
        profileDb.findUnique.mockResolvedValue(null);

        await expect(
          inspection_service.create_inspection_into_db(
            makeReq({
              body: {
                templateId: 't1',
                siteId: 's1',
                inspectorProfileId: 'nonexistent-profile',
                questionAnswers: [],
              },
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 404 });

        expect(inspectionDb.create).not.toHaveBeenCalled();
      });

      it('omitting inspectorProfileId entirely still succeeds, without querying Profile at all', async () => {
        templateDb.findFirst.mockResolvedValue({ id: 't1', orgAccountId: ORG_A });
        siteDb.findFirst.mockResolvedValue({ id: 's1', org_account_id: ORG_A });
        inspectionDb.create.mockResolvedValue({});

        await inspection_service.create_inspection_into_db(
          makeReq({
            body: {
              templateId: 't1',
              siteId: 's1',
              questionAnswers: [],
            },
          }),
        );

        expect(profileDb.findUnique).not.toHaveBeenCalled();
        const callArg = inspectionDb.create.mock.calls[0][0];
        expect(callArg.data.inspectorProfileId).toBeUndefined();
        expect(inspectionDb.create).toHaveBeenCalled();
      });
    });
  });

  describe('update_inspection_into_db', () => {
    it('verifies ownership before updating', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'i1', orgAccountId: ORG_A });
      inspectionDb.update.mockResolvedValue({});

      await inspection_service.update_inspection_into_db(
        makeReq({ params: { id: 'i1' }, body: {} }),
      );

      expect(inspectionDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'i1', orgAccountId: ORG_A },
      });
    });

    it('throws 404 and does NOT update another org inspection', async () => {
      inspectionDb.findFirst.mockResolvedValue(null);

      await expect(
        inspection_service.update_inspection_into_db(makeReq({ params: { id: 'org-b-insp' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(inspectionDb.update).not.toHaveBeenCalled();
    });

    it('writes the attachments array when provided (#53)', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'i1', orgAccountId: ORG_A });
      inspectionDb.update.mockResolvedValue({});

      await inspection_service.update_inspection_into_db(
        makeReq({
          params: { id: 'i1' },
          body: { attachments: ['https://cdn.example.com/a.pdf'] },
        }),
      );

      expect(inspectionDb.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { attachments: ['https://cdn.example.com/a.pdf'] },
      });
    });

    it('clears attachments when an empty array is explicitly sent, not silently dropped like a falsy field', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'i1', orgAccountId: ORG_A });
      inspectionDb.update.mockResolvedValue({});

      await inspection_service.update_inspection_into_db(
        makeReq({ params: { id: 'i1' }, body: { attachments: [] } }),
      );

      expect(inspectionDb.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { attachments: [] },
      });
    });

    it('does not touch attachments when the field is omitted entirely', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'i1', orgAccountId: ORG_A });
      inspectionDb.update.mockResolvedValue({});

      await inspection_service.update_inspection_into_db(
        makeReq({ params: { id: 'i1' }, body: { status: 'COMPLETED' } }),
      );

      expect(inspectionDb.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { status: 'COMPLETED' },
      });
    });

    // quality-bar-loop (Inspections, round 3, resilience/security finding):
    // a client-supplied siteId was written with zero check it belongs to
    // the caller's org, unlike create_inspection_into_db's siteId check —
    // letting a caller silently reassign an inspection to another org's
    // site.
    it('rejects reassigning the inspection to a site from another org', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'i1', orgAccountId: ORG_A });
      siteDb.findFirst.mockResolvedValue(null);

      await expect(
        inspection_service.update_inspection_into_db(
          makeReq({ params: { id: 'i1' }, body: { siteId: 'org-b-site' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(siteDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'org-b-site', org_account_id: ORG_A },
      });
      expect(inspectionDb.update).not.toHaveBeenCalled();
    });

    it('allows reassigning to a site that does belong to the caller org', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'i1', orgAccountId: ORG_A });
      siteDb.findFirst.mockResolvedValue({ id: 's2', org_account_id: ORG_A });
      inspectionDb.update.mockResolvedValue({});

      await inspection_service.update_inspection_into_db(
        makeReq({ params: { id: 'i1' }, body: { siteId: 's2' } }),
      );

      expect(inspectionDb.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { siteId: 's2' },
      });
    });
  });

  describe('delete_inspection_from_db', () => {
    it('verifies ownership before deleting', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'i1', orgAccountId: ORG_A });
      inspectionDb.delete.mockResolvedValue({});

      await inspection_service.delete_inspection_from_db(makeReq({ params: { id: 'i1' } }));

      expect(inspectionDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'i1', orgAccountId: ORG_A },
      });
    });

    it('throws 404 and does NOT delete another org inspection', async () => {
      inspectionDb.findFirst.mockResolvedValue(null);

      await expect(
        inspection_service.delete_inspection_from_db(makeReq({ params: { id: 'org-b-insp' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(inspectionDb.delete).not.toHaveBeenCalled();
    });
  });

  describe('update_inspection_question_into_db — org scoping via parent inspection', () => {
    it('verifies question belongs to caller org via inspection.orgAccountId', async () => {
      qaDb.findUnique.mockResolvedValue({
        inspection: { orgAccountId: ORG_A },
      });
      qaDb.update.mockResolvedValue({});

      await inspection_service.update_inspection_question_into_db(
        makeReq({ params: { id: 'qa1' }, body: { answer: 'Yes' } }),
      );

      expect(qaDb.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'qa1' } }),
      );
      expect(qaDb.update).toHaveBeenCalled();
    });

    it('throws 404 when question belongs to another org inspection', async () => {
      qaDb.findUnique.mockResolvedValue({
        inspection: { orgAccountId: 'some-other-org' },
      });

      await expect(
        inspection_service.update_inspection_question_into_db(
          makeReq({ params: { id: 'org-b-qa' }, body: {} }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(qaDb.update).not.toHaveBeenCalled();
    });

    it('throws 404 when question answer does not exist at all', async () => {
      qaDb.findUnique.mockResolvedValue(null);

      await expect(
        inspection_service.update_inspection_question_into_db(
          makeReq({ params: { id: 'nonexistent' }, body: {} }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('split_note_into_inspection_using_ai (ticket #23)', () => {
    it('scopes both the note and inspection lookups by org', async () => {
      noteDb.findUnique.mockResolvedValue({ extracted_text: 'text' });
      inspectionDb.findUnique.mockResolvedValue({ questionAnswers: [] });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
      );

      await inspection_service.split_note_into_inspection_using_ai(
        makeReq({ params: { inspectionId: 'insp-1' } }),
      );

      expect(noteDb.findUnique).toHaveBeenCalledWith({
        where: { inspectionId: 'insp-1', orgAccountId: ORG_A },
        select: { extracted_text: true },
      });
      expect(inspectionDb.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'insp-1', orgAccountId: ORG_A },
        }),
      );
    });

    it('sends the shared internal secret and a signed org-identity token on the aexa-ai call (#56)', async () => {
      noteDb.findUnique.mockResolvedValue({ extracted_text: 'text' });
      inspectionDb.findUnique.mockResolvedValue({ questionAnswers: [] });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
      );

      await inspection_service.split_note_into_inspection_using_ai(
        makeReq({ params: { inspectionId: 'insp-1' } }),
      );

      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.headers).toHaveProperty('X-Internal-Secret');
      expect(init.headers).toHaveProperty('X-Org-Token');
      expect(jwtDecode(init.headers['X-Org-Token']).org_account_id).toBe(ORG_A);
    });

    it('throws 404 when the inspection belongs to another org', async () => {
      noteDb.findUnique.mockResolvedValue({ extracted_text: 'text' });
      inspectionDb.findUnique.mockResolvedValue(null);

      await expect(
        inspection_service.split_note_into_inspection_using_ai(
          makeReq({ params: { inspectionId: 'org-b-insp' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 404 when the note belongs to another org', async () => {
      noteDb.findUnique.mockResolvedValue(null);
      inspectionDb.findUnique.mockResolvedValue({ questionAnswers: [] });

      await expect(
        inspection_service.split_note_into_inspection_using_ai(
          makeReq({ params: { inspectionId: 'insp-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    // Issue #273: aexa-ai's response echoes back qestionAnswerId values with
    // no guarantee they're actually one of the ids we sent (all scoped to
    // this inspection). Writing straight to `where: { id: item.qestionAnswerId }`
    // with no membership check let a stale/mismatched id overwrite an
    // arbitrary QuestionAnswer row in ANY org's inspection, since ids are
    // global. Same IDOR family as #50/#84.
    describe("filters AI-returned qestionAnswerId against the inspection's own ids (#273)", () => {
      it("applies an update for a qestionAnswerId that IS one of this inspection's ids", async () => {
        noteDb.findUnique.mockResolvedValue({ extracted_text: 'text' });
        inspectionDb.findUnique.mockResolvedValue({
          questionAnswers: [
            { id: 'qa-1', question: { question: 'Q1', answerType: 'TEXT' } },
            { id: 'qa-2', question: { question: 'Q2', answerType: 'TEXT' } },
          ],
        });
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
              question: [{ qestionAnswerId: 'qa-1', answer: 'Yes', note: 'looks fine' }],
            }),
          }),
        );
        qaDb.update.mockResolvedValue({});

        await inspection_service.split_note_into_inspection_using_ai(
          makeReq({ params: { inspectionId: 'insp-1' } }),
        );

        expect(qaDb.update).toHaveBeenCalledTimes(1);
        expect(qaDb.update).toHaveBeenCalledWith({
          where: { id: 'qa-1' },
          data: { answer: 'Yes', note: 'looks fine' },
        });
      });

      it("drops a qestionAnswerId that is NOT one of this inspection's ids instead of writing to it", async () => {
        noteDb.findUnique.mockResolvedValue({ extracted_text: 'text' });
        inspectionDb.findUnique.mockResolvedValue({
          questionAnswers: [{ id: 'qa-1', question: { question: 'Q1', answerType: 'TEXT' } }],
        });
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
              question: [
                { qestionAnswerId: 'qa-1', answer: 'Yes' },
                // Stale/mismatched id from aexa-ai — belongs to some other
                // inspection (possibly another org) entirely.
                { qestionAnswerId: 'org-b-qa-99', answer: 'Hijacked' },
              ],
            }),
          }),
        );
        qaDb.update.mockResolvedValue({});

        await inspection_service.split_note_into_inspection_using_ai(
          makeReq({ params: { inspectionId: 'insp-1' } }),
        );

        expect(qaDb.update).toHaveBeenCalledTimes(1);
        expect(qaDb.update).not.toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: 'org-b-qa-99' } }),
        );
      });

      it('drops all AI-returned ids and updates nothing when none match this inspection', async () => {
        noteDb.findUnique.mockResolvedValue({ extracted_text: 'text' });
        inspectionDb.findUnique.mockResolvedValue({
          questionAnswers: [{ id: 'qa-1', question: { question: 'Q1', answerType: 'TEXT' } }],
        });
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
              question: [{ qestionAnswerId: 'org-b-qa-99', answer: 'Hijacked' }],
            }),
          }),
        );

        await inspection_service.split_note_into_inspection_using_ai(
          makeReq({ params: { inspectionId: 'insp-1' } }),
        );

        expect(qaDb.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('role scoping (issue #55 slice 3)', () => {
    const ANCHOR = 'anchor-account-00000000-0000-0000-0000-000000000009';
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
      organizationDb.findUnique.mockResolvedValue({
        id: ORG_ID,
        anchorAccountId: ANCHOR,
      });
    };

    it('ADMIN with a real OrgMember row still sees the whole org (anchor account, no id restriction)', async () => {
      mockMembership('ADMIN');
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ orgAccountId: ANCHOR });
      expect(findArg.where.id).toBeUndefined();
      expect(assignmentDb.findMany).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR list is restricted to their assigned inspection ids', async () => {
      mockMembership('LEAD_AUDITOR');
      assignmentDb.findMany.mockResolvedValue([
        { inspectionId: 'insp-assigned-1' },
        { inspectionId: 'insp-assigned-2' },
      ]);
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      expect(assignmentDb.findMany).toHaveBeenCalledWith({
        where: { orgMemberId: MEMBER_ID, revokedAt: null },
        select: { inspectionId: true },
      });
      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({
        orgAccountId: ANCHOR,
        id: { in: ['insp-assigned-1', 'insp-assigned-2'] },
      });
    });

    it('LEAD_AUDITOR requesting an inspection they are NOT assigned to gets nothing back', async () => {
      mockMembership('LEAD_AUDITOR');
      assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
      inspectionDb.findFirst.mockResolvedValue(null);

      await expect(
        inspection_service.get_single_inspection_from_db(
          makeReq({ params: { id: 'insp-not-assigned' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      const [findArg] = inspectionDb.findFirst.mock.calls[0];
      // The requested id isn't in the assigned set, so the id filter
      // collapses to an impossible match rather than the raw requested id.
      expect(findArg.where.id).toEqual({ in: [] });
    });

    it('LEAD_AUDITOR requesting an assigned inspection is allowed through', async () => {
      mockMembership('LEAD_AUDITOR');
      assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
      inspectionDb.findFirst.mockResolvedValue({ id: 'insp-assigned-1' });

      await inspection_service.get_single_inspection_from_db(
        makeReq({ params: { id: 'insp-assigned-1' } }),
      );

      const [findArg] = inspectionDb.findFirst.mock.calls[0];
      expect(findArg.where.id).toBe('insp-assigned-1');
    });

    it('VIEWER with zero InspectionAssignment rows sees the whole org', async () => {
      mockMembership('VIEWER');
      assignmentDb.findMany.mockResolvedValue([]);
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ orgAccountId: ANCHOR });
      expect(findArg.where.id).toBeUndefined();
    });

    it('VIEWER with 1+ InspectionAssignment rows is scoped the same way Lead Auditor is', async () => {
      mockMembership('VIEWER');
      assignmentDb.findMany.mockResolvedValue([
        { inspectionId: 'insp-assigned-1', revokedAt: null },
      ]);
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ id: { in: ['insp-assigned-1'] } });
    });

    it('LIGHT_USER gets nothing back (deny by default — real scoping ships in slice 4)', async () => {
      mockMembership('LIGHT_USER');
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where.id).toEqual({ in: [] });
      // Light User scoping doesn't need InspectionAssignment lookups at all.
      expect(assignmentDb.findMany).not.toHaveBeenCalled();
    });

    it('a caller with no OrgMember row falls back to full ADMIN-equivalent access', async () => {
      orgMemberDb.findUnique.mockResolvedValue(null);
      inspectionDb.count.mockResolvedValue(0);
      inspectionDb.findMany.mockResolvedValue([]);

      await inspection_service.get_all_inspection_from_db(makeReq({ query: {} }));

      const [findArg] = inspectionDb.findMany.mock.calls[0];
      expect(findArg.where).toMatchObject({ orgAccountId: ORG_A });
      expect(findArg.where.id).toBeUndefined();
      expect(organizationDb.findUnique).not.toHaveBeenCalled();
    });

    it('inspection creation is ADMIN-only', async () => {
      mockMembership('LEAD_AUDITOR');

      await expect(
        inspection_service.create_inspection_into_db(
          makeReq({
            body: { templateId: 't1', siteId: 's1', inspectorProfileId: 'p1', questionAnswers: [] },
          }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(inspectionDb.create).not.toHaveBeenCalled();
    });

    describe('write-path scoping (update/delete)', () => {
      it('LEAD_AUDITOR assigned to the inspection can update it', async () => {
        mockMembership('LEAD_AUDITOR');
        assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-assigned-1', orgAccountId: ANCHOR });
        inspectionDb.update.mockResolvedValue({});

        await inspection_service.update_inspection_into_db(
          makeReq({ params: { id: 'insp-assigned-1' }, body: { status: 'COMPLETE' } }),
        );

        expect(inspectionDb.update).toHaveBeenCalled();
      });

      it('LEAD_AUDITOR NOT assigned to the inspection is rejected on update, even though it exists in their org', async () => {
        mockMembership('LEAD_AUDITOR');
        assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-not-assigned', orgAccountId: ANCHOR });

        await expect(
          inspection_service.update_inspection_into_db(
            makeReq({ params: { id: 'insp-not-assigned' }, body: { status: 'COMPLETE' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(inspectionDb.update).not.toHaveBeenCalled();
      });

      it('VIEWER can never update an inspection, even one in their scope', async () => {
        mockMembership('VIEWER');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });

        await expect(
          inspection_service.update_inspection_into_db(
            makeReq({ params: { id: 'insp-1' }, body: { status: 'COMPLETE' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(inspectionDb.update).not.toHaveBeenCalled();
      });

      it('LEAD_AUDITOR cannot delete an inspection even if assigned to it — deletion stays ADMIN-only', async () => {
        mockMembership('LEAD_AUDITOR');
        assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-assigned-1' }]);
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-assigned-1', orgAccountId: ANCHOR });

        await expect(
          inspection_service.delete_inspection_from_db(
            makeReq({ params: { id: 'insp-assigned-1' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(inspectionDb.delete).not.toHaveBeenCalled();
      });

      it('ADMIN can update and delete any inspection in the org regardless of assignment', async () => {
        mockMembership('ADMIN');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });
        inspectionDb.update.mockResolvedValue({});
        inspectionDb.delete.mockResolvedValue({});

        await inspection_service.update_inspection_into_db(
          makeReq({ params: { id: 'insp-1' }, body: { status: 'COMPLETE' } }),
        );
        expect(inspectionDb.update).toHaveBeenCalled();

        await inspection_service.delete_inspection_from_db(makeReq({ params: { id: 'insp-1' } }));
        expect(inspectionDb.delete).toHaveBeenCalled();
        expect(assignmentDb.findMany).not.toHaveBeenCalled();
      });
    });

    describe('assignment endpoints — the mechanism that actually creates InspectionAssignment rows', () => {
      it('ADMIN can assign a member to an inspection', async () => {
        mockMembership('ADMIN');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });
        (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
          .fn()
          .mockResolvedValue({ id: 'target-member', organizationId: ORG_ID });
        assignmentDb.findFirst.mockResolvedValue(null);
        assignmentDb.create.mockResolvedValue({
          orgMemberId: 'target-member',
          inspectionId: 'insp-1',
        });

        const result = await inspection_service.assign_member_to_inspection(
          makeReq({ params: { id: 'insp-1' }, body: { orgMemberId: 'target-member' } }),
        );

        expect(assignmentDb.findFirst).toHaveBeenCalledWith({
          where: { orgMemberId: 'target-member', inspectionId: 'insp-1', revokedAt: null },
        });
        expect(assignmentDb.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              orgMemberId: 'target-member',
              inspectionId: 'insp-1',
            }),
          }),
        );
        expect(result).toMatchObject({ orgMemberId: 'target-member', inspectionId: 'insp-1' });
      });

      it('re-assigning an already (actively) assigned member is a no-op that returns the existing row', async () => {
        mockMembership('ADMIN');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });
        (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
          .fn()
          .mockResolvedValue({ id: 'target-member', organizationId: ORG_ID });
        const existing = {
          id: 'existing-assignment',
          orgMemberId: 'target-member',
          inspectionId: 'insp-1',
        };
        assignmentDb.findFirst.mockResolvedValue(existing);

        const result = await inspection_service.assign_member_to_inspection(
          makeReq({ params: { id: 'insp-1' }, body: { orgMemberId: 'target-member' } }),
        );

        expect(assignmentDb.create).not.toHaveBeenCalled();
        expect(result).toEqual(existing);
      });

      it('converts a concurrent assign race (partial unique index violation) into the winning row, not a raw 500', async () => {
        mockMembership('ADMIN');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });
        (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
          .fn()
          .mockResolvedValue({ id: 'target-member', organizationId: ORG_ID });
        const winner = {
          id: 'winning-assignment',
          orgMemberId: 'target-member',
          inspectionId: 'insp-1',
        };
        // First findFirst (existingActive check) sees nothing; the create()
        // then races against a concurrent request and loses to the DB's
        // partial unique index; the second findFirst (inside the catch)
        // picks up the row the other request just committed.
        assignmentDb.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
        const { Prisma } = await import('@prisma/client');
        assignmentDb.create.mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        );

        const result = await inspection_service.assign_member_to_inspection(
          makeReq({ params: { id: 'insp-1' }, body: { orgMemberId: 'target-member' } }),
        );

        expect(result).toEqual(winner);
      });

      it('non-ADMIN cannot assign anyone to an inspection', async () => {
        mockMembership('LEAD_AUDITOR');

        await expect(
          inspection_service.assign_member_to_inspection(
            makeReq({ params: { id: 'insp-1' }, body: { orgMemberId: 'target-member' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(assignmentDb.create).not.toHaveBeenCalled();
      });

      it("rejects assigning a member who does not belong to the caller's org", async () => {
        mockMembership('ADMIN');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });
        (prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>).findFirst = vi
          .fn()
          .mockResolvedValue(null);

        await expect(
          inspection_service.assign_member_to_inspection(
            makeReq({ params: { id: 'insp-1' }, body: { orgMemberId: 'someone-elses-member' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 404 });

        expect(assignmentDb.create).not.toHaveBeenCalled();
      });

      it('ADMIN can unassign a member from an inspection', async () => {
        mockMembership('ADMIN');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });
        orgMemberDb.findFirst.mockResolvedValue({ id: 'target-member', organizationId: ORG_ID });
        assignmentDb.updateMany.mockResolvedValue({ count: 1 });

        await inspection_service.unassign_member_from_inspection(
          makeReq({ params: { id: 'insp-1', orgMemberId: 'target-member' } }),
        );

        expect(assignmentDb.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { orgMemberId: 'target-member', inspectionId: 'insp-1', revokedAt: null },
            data: expect.objectContaining({ revokedAt: expect.any(Date) }),
          }),
        );
      });

      it("rejects unassigning a member id that does not belong to the caller's org", async () => {
        mockMembership('ADMIN');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });
        orgMemberDb.findFirst.mockResolvedValue(null);

        await expect(
          inspection_service.unassign_member_from_inspection(
            makeReq({ params: { id: 'insp-1', orgMemberId: 'someone-elses-member' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 404 });

        expect(assignmentDb.updateMany).not.toHaveBeenCalled();
      });

      it('non-ADMIN cannot unassign anyone', async () => {
        mockMembership('VIEWER');

        await expect(
          inspection_service.unassign_member_from_inspection(
            makeReq({ params: { id: 'insp-1', orgMemberId: 'target-member' } }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(assignmentDb.updateMany).not.toHaveBeenCalled();
      });

      it('ADMIN can list assignments for an inspection in their org', async () => {
        mockMembership('ADMIN');
        inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });
        const rows = [
          {
            orgMemberId: 'target-member',
            inspectionId: 'insp-1',
            orgMember: {
              id: 'target-member',
              role: 'LEAD_AUDITOR',
              account: { email: 'auditor@test.com', profile: { fullName: 'Auditor One' } },
            },
          },
        ];
        assignmentDb.findMany.mockResolvedValue(rows);

        const result = await inspection_service.get_inspection_assignments(
          makeReq({ params: { id: 'insp-1' } }),
        );

        expect(assignmentDb.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { inspectionId: 'insp-1', revokedAt: null } }),
        );
        expect(result).toEqual(rows);
      });

      it('non-ADMIN cannot list assignments', async () => {
        mockMembership('LEAD_AUDITOR');

        await expect(
          inspection_service.get_inspection_assignments(makeReq({ params: { id: 'insp-1' } })),
        ).rejects.toMatchObject({ statusCode: 403 });

        expect(assignmentDb.findMany).not.toHaveBeenCalled();
      });

      it('ADMIN cannot list assignments for an inspection outside their org', async () => {
        mockMembership('ADMIN');
        inspectionDb.findFirst.mockResolvedValue(null);

        await expect(
          inspection_service.get_inspection_assignments(makeReq({ params: { id: 'org-b-insp' } })),
        ).rejects.toMatchObject({ statusCode: 404 });

        expect(assignmentDb.findMany).not.toHaveBeenCalled();
      });
    });

    // aexa-frontend#270: self-scoped counterpart to get_inspection_assignments
    // (admin-only) -- lets a LEAD_AUDITOR (or any member) see their OWN
    // InspectionAssignment rows, so the frontend can narrow write affordances
    // by real assignment state instead of role alone.
    describe('get_my_inspection_assignments (aexa-frontend#270)', () => {
      it("returns the caller's own assignment rows (active and revoked), scoped by orgMemberId", async () => {
        mockMembership('LEAD_AUDITOR');
        const rows = [
          { id: 'a1', inspectionId: 'insp-1', revokedAt: null, createdAt: new Date() },
          { id: 'a2', inspectionId: 'insp-2', revokedAt: new Date(), createdAt: new Date() },
        ];
        assignmentDb.findMany.mockResolvedValue(rows);

        const result = await inspection_service.get_my_inspection_assignments(makeReq({}));

        expect(assignmentDb.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: { orgMemberId: MEMBER_ID } }),
        );
        expect(result).toEqual(rows);
      });

      it('returns an empty array (not an error) for a caller with no OrgMember row, without querying the DB', async () => {
        // Backward-compat ADMIN-of-self fallback -- orgMemberId is null.
        orgMemberDb.findUnique.mockResolvedValue(null);

        const result = await inspection_service.get_my_inspection_assignments(makeReq({}));

        expect(result).toEqual([]);
        expect(assignmentDb.findMany).not.toHaveBeenCalled();
      });

      it('every role can call this -- it is self-scoped, not role-gated', async () => {
        mockMembership('VIEWER');
        assignmentDb.findMany.mockResolvedValue([]);

        await expect(
          inspection_service.get_my_inspection_assignments(makeReq({})),
        ).resolves.toEqual([]);
      });
    });
  });
});
