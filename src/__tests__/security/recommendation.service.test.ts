import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    recommendation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    recommendationResult: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    orgMember: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { recommendation_service } from '../../app/modules/recommendation/recommendation.service.js';

const recDb = prisma.recommendation as unknown as Record<string, ReturnType<typeof vi.fn>>;
const resultDb = prisma.recommendationResult as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('recommendation service — org scoping (ticket #6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no OrgMember row — ADMIN-of-self fallback (org anchor ===
    // caller's own accountId), same as every pre-org-scoping-migration test
    // in this file expects.
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  describe('get_all_recommendation_from_db', () => {
    it('filters by caller org', async () => {
      recDb.findMany.mockResolvedValue([]);

      await recommendation_service.get_all_recommendation_from_db(makeReq());

      expect(recDb.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orgAccountId: ORG_A } }),
      );
    });
  });

  describe('get_single_recommendation_from_db', () => {
    it('includes orgAccountId in WHERE clause', async () => {
      recDb.findFirst.mockResolvedValue({ id: 'rec1', orgAccountId: ORG_A });

      await recommendation_service.get_single_recommendation_from_db(
        makeReq({ params: { id: 'rec1' } }),
      );

      expect(recDb.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'rec1', orgAccountId: ORG_A } }),
      );
    });

    it('throws 404 for another org recommendation', async () => {
      recDb.findFirst.mockResolvedValue(null);

      await expect(
        recommendation_service.get_single_recommendation_from_db(
          makeReq({ params: { id: 'org-b-rec' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('update_recommendation_answer_into_db', () => {
    it('verifies answer belongs to caller org via recommendation.orgAccountId', async () => {
      resultDb.findFirst.mockResolvedValue({
        recommendationAi: { orgAccountId: ORG_A },
      });
      resultDb.update.mockResolvedValue({});

      await recommendation_service.update_recommendation_answer_into_db(
        makeReq({ params: { recQuestionId: 'rq1' }, body: { observation: 'OK' } }),
      );

      expect(resultDb.update).toHaveBeenCalled();
    });

    it('throws 404 when answer belongs to another org recommendation', async () => {
      resultDb.findFirst.mockResolvedValue({
        recommendationAi: { orgAccountId: 'other-org' },
      });

      await expect(
        recommendation_service.update_recommendation_answer_into_db(
          makeReq({ params: { recQuestionId: 'rq1' }, body: {} }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(resultDb.update).not.toHaveBeenCalled();
    });
  });

  describe('update_recommendation_summary_into_db', () => {
    it('verifies org before updating summary', async () => {
      recDb.findFirst.mockResolvedValue({ id: 'rec1', orgAccountId: ORG_A });
      recDb.update.mockResolvedValue({});

      await recommendation_service.update_recommendation_summary_into_db(
        makeReq({ params: { recommendationId: 'rec1' }, body: { summary: 'All good' } }),
      );

      expect(recDb.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'rec1', orgAccountId: ORG_A } }),
      );
    });

    it('throws 404 for another org recommendation', async () => {
      recDb.findFirst.mockResolvedValue(null);

      await expect(
        recommendation_service.update_recommendation_summary_into_db(
          makeReq({ params: { recommendationId: 'org-b-rec' }, body: {} }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('delete_recommendation_from_db', () => {
    it('verifies ownership before deleting', async () => {
      recDb.findFirst.mockResolvedValue({ id: 'rec1', orgAccountId: ORG_A });
      recDb.delete.mockResolvedValue({});

      await recommendation_service.delete_recommendation_from_db(
        makeReq({ params: { id: 'rec1' } }),
      );

      expect(recDb.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'rec1', orgAccountId: ORG_A } }),
      );
    });

    it('throws 404 and does NOT delete another org recommendation', async () => {
      recDb.findFirst.mockResolvedValue(null);

      await expect(
        recommendation_service.delete_recommendation_from_db(
          makeReq({ params: { id: 'org-b-rec' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(recDb.delete).not.toHaveBeenCalled();
    });
  });

  describe('get_recommendation_by_inspectionId_from_db', () => {
    it('filters by both inspectionId and caller org', async () => {
      recDb.findFirst.mockResolvedValue({ id: 'rec1', orgAccountId: ORG_A });

      await recommendation_service.get_recommendation_by_inspectionId_from_db(
        makeReq({ params: { inspectionId: 'insp1' } }),
      );

      expect(recDb.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { inspectionId: 'insp1', orgAccountId: ORG_A },
        }),
      );
    });

    it('throws 404 when inspection belongs to another org', async () => {
      recDb.findFirst.mockResolvedValue(null);

      await expect(
        recommendation_service.get_recommendation_by_inspectionId_from_db(
          makeReq({ params: { inspectionId: 'org-b-insp' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
