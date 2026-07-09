import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeReq } from '../helpers/makeReq.js';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => Buffer.from('')),
  unlinkSync: vi.fn(),
}));

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    template: { create: vi.fn() },
    recommendation: { create: vi.fn(), findFirst: vi.fn() },
    pineconeDocument: { create: vi.fn() },
    risk: { findUnique: vi.fn() },
    inspection: { findFirst: vi.fn() },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { ai_service } from '../../app/modules/ai/ai.service.js';

const db = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

function mockAiResponse(ok: boolean, status = 502) {
  return { ok, status, json: vi.fn() } as unknown as Response;
}

describe('ai service — AI response error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  describe('generate_template_with_prompt_with_ai', () => {
    it('throws a 502 AppError when the AI service responds with a non-ok status, without creating a template', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockAiResponse(false, 503));

      await expect(
        ai_service.generate_template_with_prompt_with_ai(
          makeReq({ body: { prompt: 'fire safety' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 502 });

      expect(db.template.create).not.toHaveBeenCalled();
    });
  });

  describe('generate_template_with_pdf_with_ai', () => {
    it('throws a 502 AppError when the AI service responds with a non-ok status', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockAiResponse(false, 500));

      await expect(
        ai_service.generate_template_with_pdf_with_ai(
          makeReq({
            file: {
              path: '/tmp/does-not-matter',
              mimetype: 'application/pdf',
              originalname: 'a.pdf',
            },
          } as never),
        ),
      ).rejects.toMatchObject({ statusCode: 502 });

      expect(db.template.create).not.toHaveBeenCalled();
    });
  });

  describe('generate_template_with_risk_with_ai', () => {
    it('throws a 502 AppError when the AI service responds with a non-ok status', async () => {
      db.risk.findUnique.mockResolvedValue({ id: 'risk-1', name: 'Fire risk' });
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockAiResponse(false, 502));

      await expect(
        ai_service.generate_template_with_risk_with_ai(makeReq({ body: { riskId: 'risk-1' } })),
      ).rejects.toMatchObject({ statusCode: 502 });

      expect(db.template.create).not.toHaveBeenCalled();
    });
  });

  describe('generate_recommendation_with_inspection_from_ai', () => {
    it('throws a 502 AppError when the AI service responds with a non-ok status, without creating a recommendation', async () => {
      db.inspection.findFirst.mockResolvedValue({
        id: 'insp-1',
        orgAccountId: 'org-a-00000000-0000-0000-0000-000000000001',
        questionAnswers: [],
      });
      db.recommendation.findFirst.mockResolvedValue(null);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockAiResponse(false, 500));

      await expect(
        ai_service.generate_recommendation_with_inspection_from_ai(
          makeReq({ body: { inspectionId: 'insp-1' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 502 });

      expect(db.recommendation.create).not.toHaveBeenCalled();
    });
  });

  describe('upload_pdf_into_pinecone_via_ai', () => {
    it('throws a 502 AppError when the AI service responds with a non-ok status', async () => {
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockAiResponse(false, 503));

      await expect(
        ai_service.upload_pdf_into_pinecone_via_ai(
          makeReq({
            file: {
              path: '/tmp/does-not-matter',
              mimetype: 'application/pdf',
              originalname: 'a.pdf',
              size: 100,
            },
          } as never),
        ),
      ).rejects.toMatchObject({ statusCode: 502 });

      expect(db.pineconeDocument.create).not.toHaveBeenCalled();
    });
  });
});
