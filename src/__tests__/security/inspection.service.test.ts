import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

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
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { inspection_service } from '../../app/modules/inspection/inspection.service.js';

const inspectionDb = prisma.inspection as unknown as Record<string, ReturnType<typeof vi.fn>>;
const noteDb = prisma.note as unknown as Record<string, ReturnType<typeof vi.fn>>;
const templateDb = prisma.template as unknown as Record<string, ReturnType<typeof vi.fn>>;
const siteDb = prisma.site as unknown as Record<string, ReturnType<typeof vi.fn>>;
const qaDb = prisma.questionAnswer as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('inspection service — org scoping (ticket #6)', () => {
  beforeEach(() => vi.clearAllMocks());

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
  });
});
