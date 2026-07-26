import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORG_A, makeReq } from '../helpers/makeReq.js';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => Buffer.from('')),
  unlinkSync: vi.fn(),
}));

vi.mock('../../app/utils/cloudinary.js', () => ({
  default: vi.fn(),
}));

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    note: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    inspection: {
      findFirst: vi.fn(),
    },
    orgMember: {
      findUnique: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
    inspectionAssignment: {
      findMany: vi.fn(),
    },
  },
}));

import * as fs from 'fs';
import jwt from 'jsonwebtoken';
import { prisma } from '../../app/lib/prisma.js';
import uploadCloud from '../../app/utils/cloudinary.js';
import { note_service } from '../../app/modules/note/note.service.js';

// setup.ts sets AI_INTERNAL_SECRET = 'test-ai-internal-secret' before any
// config import — the exact secret mintOrgToken signs the X-Org-Token with.
const jwtDecode = (token: string) => jwt.verify(token, 'test-ai-internal-secret') as jwt.JwtPayload;

const mockUploadCloud = vi.mocked(uploadCloud);
const mockUnlinkSync = vi.mocked(fs.unlinkSync);
const db = prisma.note as unknown as Record<string, ReturnType<typeof vi.fn>>;
const inspectionDb = prisma.inspection as unknown as Record<string, ReturnType<typeof vi.fn>>;
const orgMemberDb = prisma.orgMember as unknown as Record<string, ReturnType<typeof vi.fn>>;
const organizationDb = prisma.organization as unknown as Record<string, ReturnType<typeof vi.fn>>;
const assignmentDb = prisma.inspectionAssignment as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;

const ANCHOR = ORG_A;
const ORG_ID = 'org-00000000-0000-0000-0000-000000000009';
const MEMBER_ID = 'org-member-00000000-0000-0000-0000-000000000009';

// Sets up a real (non-fallback) OrgMember row so role gating is actually
// exercised, instead of the ADMIN-of-self backward-compat fallback every
// other test in this file relies on.
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

describe('note service — org scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    // Default: no OrgMember row — ADMIN-of-self fallback (org anchor ===
    // caller's own accountId), same as every pre-org-scoping-migration test
    // in this file expects.
    orgMemberDb.findUnique.mockResolvedValue(null);
  });

  describe('write-path role scoping (issue #55 slice 3)', () => {
    it('VIEWER cannot create a note, even on an inspection in their org', async () => {
      mockMembership('VIEWER');
      inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });

      await expect(
        note_service.save_raw_note_into_db(
          makeReq({ body: { inspectionId: 'insp-1', title: 'T', extracted_text: 'X' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('LIGHT_USER cannot create a note', async () => {
      mockMembership('LIGHT_USER');
      inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });

      await expect(
        note_service.save_raw_note_into_db(
          makeReq({ body: { inspectionId: 'insp-1', title: 'T', extracted_text: 'X' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.create).not.toHaveBeenCalled();
    });

    it('LEAD_AUDITOR not assigned to the inspection cannot update its note', async () => {
      mockMembership('LEAD_AUDITOR');
      assignmentDb.findMany.mockResolvedValue([{ inspectionId: 'insp-other' }]);
      db.findFirst.mockResolvedValue({ id: 'n1', orgAccountId: ANCHOR, inspectionId: 'insp-1' });

      await expect(
        note_service.update_note_into_db(
          makeReq({ params: { id: 'n1' }, body: { title: 'hack' } }),
        ),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('VIEWER cannot delete a note', async () => {
      mockMembership('VIEWER');
      db.findFirst.mockResolvedValue({ id: 'n1', orgAccountId: ANCHOR, inspectionId: 'insp-1' });

      await expect(
        note_service.delete_note_from_db(makeReq({ params: { id: 'n1' } })),
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(db.delete).not.toHaveBeenCalled();
    });

    it('ADMIN can still create a note (role gate does not over-block)', async () => {
      mockMembership('ADMIN');
      inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ANCHOR });
      db.findFirst.mockResolvedValue(null);
      db.create.mockResolvedValue({});

      await note_service.save_raw_note_into_db(
        makeReq({ body: { inspectionId: 'insp-1', title: 'T', extracted_text: 'X' } }),
      );

      expect(db.create).toHaveBeenCalled();
    });
  });

  describe('get_all_note_from_db', () => {
    it('filters findMany by caller org', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(0);

      await note_service.get_all_note_from_db(makeReq());

      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.where).toMatchObject({ orgAccountId: ORG_A });
    });

    it('paginates results', async () => {
      db.findMany.mockResolvedValue([]);
      db.count.mockResolvedValue(25);

      const result = await note_service.get_all_note_from_db(
        makeReq({ query: { page: '2', limit: '10' } }),
      );

      const [callArg] = db.findMany.mock.calls[0];
      expect(callArg.skip).toBe(10);
      expect(callArg.take).toBe(10);
      expect(result.meta).toEqual({ page: 2, limit: 10, skip: 10, total: 25, totalPage: 3 });
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
    const FILE = { path: '/tmp/whatever', mimetype: 'application/pdf', originalname: 'a.pdf' };

    it('throws 404 and does NOT proceed to file processing when the inspectionId belongs to another org', async () => {
      inspectionDb.findFirst.mockResolvedValue(null);

      await expect(
        note_service.extract_note_from_any_file_or_image_and_save_into_db(
          makeReq({
            body: { inspectionId: 'org-b-inspection' },
            file: FILE,
          } as never),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });

      expect(inspectionDb.findFirst).toHaveBeenCalledWith({
        where: { id: 'org-b-inspection', orgAccountId: ORG_A },
      });
      expect(db.findFirst).not.toHaveBeenCalled();
      expect(db.create).not.toHaveBeenCalled();
    });

    it('uploads the source file and stores its URL in attachments (#54)', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ORG_A });
      db.findFirst.mockResolvedValue(null);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ title: 'T', extracted_text: 'X' }),
      });
      mockUploadCloud.mockResolvedValue({ secure_url: 'https://s3.example.com/a.pdf' } as never);
      db.create.mockResolvedValue({});

      await note_service.extract_note_from_any_file_or_image_and_save_into_db(
        makeReq({ body: { inspectionId: 'insp-1' }, file: FILE } as never),
      );

      expect(mockUploadCloud).toHaveBeenCalledWith(FILE);
      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.attachments).toEqual(['https://s3.example.com/a.pdf']);
      // uploadCloud (mocked here) is the one that deletes the temp file on
      // the success path in the real implementation (cloudinary.ts) — the
      // service itself must NOT also unlink it, or it double-deletes. See
      // the "does not double-delete" regression test below for the case
      // that actually exercises this.
      expect(mockUnlinkSync).not.toHaveBeenCalled();
    });

    it('sends the signed org-identity token and the shared internal secret on the aexa-ai call (#56)', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ORG_A });
      db.findFirst.mockResolvedValue(null);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ title: 'T', extracted_text: 'X' }),
      });
      mockUploadCloud.mockResolvedValue({ secure_url: 'https://s3.example.com/a.pdf' } as never);
      db.create.mockResolvedValue({});

      await note_service.extract_note_from_any_file_or_image_and_save_into_db(
        makeReq({ body: { inspectionId: 'insp-1' }, file: FILE } as never),
      );

      const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(init.headers).toHaveProperty('X-Internal-Secret');
      expect(init.headers).toHaveProperty('X-Org-Token');
      const payload = jwtDecode(init.headers['X-Org-Token']);
      expect(payload.org_account_id).toBe(ORG_A);
    });

    it('deletes the temp file even when the AI service responds with a non-ok status (#112)', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ORG_A });
      db.findFirst.mockResolvedValue(null);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 502 });

      await expect(
        note_service.extract_note_from_any_file_or_image_and_save_into_db(
          makeReq({ body: { inspectionId: 'insp-1' }, file: FILE } as never),
        ),
      ).rejects.toMatchObject({ statusCode: 502 });

      expect(db.create).not.toHaveBeenCalled();
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
      expect(mockUnlinkSync).toHaveBeenCalledWith(FILE.path);
    });

    it('does not double-delete the temp file when uploadCloud already cleaned it up (#112 follow-up)', async () => {
      // cloudinary.ts's real uploadCloud unlinks the temp file itself once
      // it's done with it (on both its success and error paths). If
      // note.service.ts also tried to unlink unconditionally after a
      // successful upload, the second fs.unlinkSync call would throw ENOENT
      // in production and clobber the note that was just created. This
      // mock mirrors that real behavior instead of swallowing it, so the
      // regression shows up as an extra unlinkSync call here.
      inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ORG_A });
      db.findFirst.mockResolvedValue(null);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ title: 'T', extracted_text: 'X' }),
      });
      mockUploadCloud.mockImplementation(async (f: unknown) => {
        fs.unlinkSync((f as { path: string }).path);
        return { secure_url: 'https://s3.example.com/a.pdf', key: 'a.pdf' };
      });
      db.create.mockResolvedValue({ id: 'note-1' });

      const result = await note_service.extract_note_from_any_file_or_image_and_save_into_db(
        makeReq({ body: { inspectionId: 'insp-1' }, file: FILE } as never),
      );

      expect(result).toEqual({ id: 'note-1' });
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
      expect(mockUnlinkSync).toHaveBeenCalledWith(FILE.path);
    });

    it('still creates the note with empty attachments when the source-file upload fails (extraction already succeeded)', async () => {
      inspectionDb.findFirst.mockResolvedValue({ id: 'insp-1', orgAccountId: ORG_A });
      db.findFirst.mockResolvedValue(null);
      (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ title: 'T', extracted_text: 'X' }),
      });
      mockUploadCloud.mockRejectedValue(new Error('S3 unreachable'));
      db.create.mockResolvedValue({});

      await note_service.extract_note_from_any_file_or_image_and_save_into_db(
        makeReq({ body: { inspectionId: 'insp-1' }, file: FILE } as never),
      );

      const callArg = db.create.mock.calls[0][0];
      expect(callArg.data.attachments).toEqual([]);
      expect(callArg.data.extracted_text).toBe('X');
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

    it('writes attachments when provided', async () => {
      db.findFirst.mockResolvedValue({ id: 'n1', orgAccountId: ORG_A });
      db.update.mockResolvedValue({});

      await note_service.update_note_into_db(
        makeReq({
          params: { id: 'n1' },
          body: { attachments: ['https://s3.example.com/replacement.pdf'] },
        }),
      );

      expect(db.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: { attachments: ['https://s3.example.com/replacement.pdf'] },
      });
    });

    it('clears attachments on an explicit empty array, not silently dropped', async () => {
      db.findFirst.mockResolvedValue({ id: 'n1', orgAccountId: ORG_A });
      db.update.mockResolvedValue({});

      await note_service.update_note_into_db(
        makeReq({ params: { id: 'n1' }, body: { attachments: [] } }),
      );

      expect(db.update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: { attachments: [] },
      });
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
