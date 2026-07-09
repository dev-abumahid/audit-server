import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    note: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    inspection: {
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from '../../app/lib/prisma.js';
import { note_service } from '../../app/modules/note/note.service.js';

const db = prisma.note as unknown as Record<string, ReturnType<typeof vi.fn>>;
const inspectionDb = prisma.inspection as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('note service — org scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('get_all_note_from_db', () => {
    it('filters findMany by caller org', async () => {
      db.findMany.mockResolvedValue([]);

      await note_service.get_all_note_from_db(makeReq());

      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({ orgAccountId: ORG_A });
    });
  });

  describe('get_single_note_from_db', () => {
    it('includes orgAccountId in WHERE clause', async () => {
      db.findFirst.mockResolvedValue({ id: 'n1', orgAccountId: ORG_A });

      await note_service.get_single_note_from_db(makeReq({ params: { id: 'n1' } }));

      expect(db.findFirst).toHaveBeenCalledWith({
        where: { id: 'n1', orgAccountId: ORG_A },
      });
    });

    it('throws 404 when note belongs to another org', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        note_service.get_single_note_from_db(makeReq({ params: { id: 'org-b-note' } })),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('get_note_by_inspection_id_from_db', () => {
    it('includes orgAccountId in WHERE clause', async () => {
      db.findFirst.mockResolvedValue({ id: 'n1', orgAccountId: ORG_A });

      await note_service.get_note_by_inspection_id_from_db(
        makeReq({ params: { inspectionId: 'insp-1' } }),
      );

      expect(db.findFirst).toHaveBeenCalledWith({
        where: { inspectionId: 'insp-1', orgAccountId: ORG_A },
      });
    });

    it('throws 404 when inspection note belongs to another org', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        note_service.get_note_by_inspection_id_from_db(
          makeReq({ params: { inspectionId: 'org-b-insp' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('save_raw_note_into_db', () => {
    it('injects orgAccountId into the created record', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ORG_A });
      db.findFirst.mockResolvedValue(null);
      db.create.mockResolvedValue({});

      await note_service.save_raw_note_into_db(
        makeReq({ body: { inspectionId: 'insp-1', title: 'T', extracted_text: 'X' } }),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.orgAccountId).toBe(ORG_A);
    });

    it('throws 400 if note already exists for inspection', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ORG_A });
      db.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(
        note_service.save_raw_note_into_db(makeReq({ body: { inspectionId: 'insp-1' } })),
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('throws 404 and does NOT create a note when the inspectionId belongs to another org', async () => {
      inspectionDb.findFirst.mockResolvedValue(null);

      await expect(
        note_service.save_raw_note_into_db(
          makeReq({ body: { inspectionId: 'org-b-inspection', title: 'T', extracted_text: 'X' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(inspectionDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'org-b-inspection', orgAccountId: ORG_A },
      });
      expect(db.findFirst).not.toHaveBeenCalled();
      expect(db.create).not.toHaveBeenCalled();
    });
  });

  describe('extract_note_from_any_file_or_image_and_save_into_db', () => {
    it('throws 404 and does NOT proceed to file processing when the inspectionId belongs to another org', async () => {
      inspectionDb.findFirst.mockResolvedValue(null);

      await expect(
        note_service.extract_note_from_any_file_or_image_and_save_into_db(
          makeReq({
            body: { inspectionId: 'org-b-inspection' },
            file: { path: '/tmp/whatever', mimetype: 'application/pdf', originalname: 'a.pdf' },
          } as never),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(inspectionDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'org-b-inspection', orgAccountId: ORG_A },
      });
      expect(db.findFirst).not.toHaveBeenCalled();
      expect(db.create).not.toHaveBeenCalled();
    });
  });

  describe('update_note_into_db', () => {
    it('verifies ownership before updating', async () => {
      db.findFirst.mockResolvedValue({ id: 'n1', orgAccountId: ORG_A });
      db.update.mockResolvedValue({});

      await note_service.update_note_into_db(
        makeReq({ params: { id: 'n1' }, body: { title: 'New title' } }),
      );

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'n1', orgAccountId: ORG_A } });
      expect(db.update).toHaveBeenCalled();
    });

    it('throws 404 and does NOT update another org note', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        note_service.update_note_into_db(
          makeReq({ params: { id: 'org-b-note' }, body: { title: 'hack' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('delete_note_from_db', () => {
    it('verifies ownership before deleting', async () => {
      db.findFirst.mockResolvedValue({ id: 'n1', orgAccountId: ORG_A });
      db.delete.mockResolvedValue({});

      await note_service.delete_note_from_db(makeReq({ params: { id: 'n1' } }));

      expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'n1', orgAccountId: ORG_A } });
      expect(db.delete).toHaveBeenCalledWith({ where: { id: 'n1' } });
    });

    it('throws 404 and does NOT delete another org note', async () => {
      db.findFirst.mockResolvedValue(null);

      await expect(
        note_service.delete_note_from_db(makeReq({ params: { id: 'org-b-note' } })),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(db.delete).not.toHaveBeenCalled();
    });
  });
});
