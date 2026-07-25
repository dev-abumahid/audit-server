import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/prisma.js', () => ({
  prisma: {
    risk: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
}));

import { Prisma } from '@prisma/client';
import { prisma } from '../../app/lib/prisma.js';
import {
  categoryPrefix,
  computeNextRiskRef,
  createRiskWithGeneratedRef,
} from '../../app/modules/risk/risk_ref.js';

const db = prisma.risk as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('categoryPrefix', () => {
  it.each([
    ['Cyber', 'CYB'],
    ['cyber', 'CYB'],
    ['CYBER', 'CYB'],
    ['Cybersecurity', 'CYB'],
    ['Supply Chain', 'SUP'],
    ['Financial', 'FIN'],
    ['OPERATIONAL', 'OPS'],
    ['Regulatory', 'REG'],
  ])('maps known category %s -> %s', (category, expected) => {
    expect(categoryPrefix(category)).toBe(expected);
  });

  it('falls back to the first 3 letters uppercased for an unmapped category', () => {
    expect(categoryPrefix('Geopolitical')).toBe('GEO');
  });

  it('falls back to GEN for a category with fewer than 2 letters', () => {
    expect(categoryPrefix('1')).toBe('GEN');
    expect(categoryPrefix('')).toBe('GEN');
  });

  it('strips non-alphabetic characters before taking the fallback prefix', () => {
    expect(categoryPrefix('R&D')).toBe('RD');
  });
});

describe('computeNextRiskRef', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts at 001 when no existing refs share the prefix', async () => {
    db.findMany.mockResolvedValue([]);
    const ref = await computeNextRiskRef(prisma, 'org-1', 'Cyber');
    expect(ref).toBe('CYB-001');
    expect(db.findMany).toHaveBeenCalledWith({
      where: { org_account_id: 'org-1', ref: { startsWith: 'CYB-' } },
      select: { ref: true },
    });
  });

  it('continues from the highest existing sequence number for that prefix', async () => {
    db.findMany.mockResolvedValue([{ ref: 'CYB-001' }, { ref: 'CYB-007' }, { ref: 'CYB-003' }]);
    const ref = await computeNextRiskRef(prisma, 'org-1', 'Cyber');
    expect(ref).toBe('CYB-008');
  });

  it('ignores refs under a different prefix scoped to the same org', async () => {
    // findMany is called with a startsWith filter, so in a real DB call it
    // would already be scoped -- this test guards the regex match itself
    // against a same-org row that slipped through with an unrelated shape.
    db.findMany.mockResolvedValue([{ ref: 'SUP-099' }]);
    const ref = await computeNextRiskRef(prisma, 'org-1', 'Cyber');
    expect(ref).toBe('CYB-001');
  });

  it('pads sequence numbers beyond 999 without truncating', async () => {
    db.findMany.mockResolvedValue([{ ref: 'CYB-999' }]);
    const ref = await computeNextRiskRef(prisma, 'org-1', 'Cyber');
    expect(ref).toBe('CYB-1000');
  });
});

describe('createRiskWithGeneratedRef', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates a ref and creates the risk with it', async () => {
    db.findMany.mockResolvedValue([]);
    db.create.mockResolvedValue({ id: 'risk-1', ref: 'CYB-001' });

    const result = await createRiskWithGeneratedRef({
      org_account_id: 'org-1',
      name: 'Test risk',
      category: 'Cyber',
      status: 'open',
      site_id: 'site-1',
    } as any);

    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ref: 'CYB-001', category: 'Cyber' }),
    });
    expect(result).toEqual({ id: 'risk-1', ref: 'CYB-001' });
  });

  it('retries with a recomputed ref on a unique-constraint conflict, then succeeds', async () => {
    // First read sees no existing rows and computes CYB-001; the create call
    // fails as if a concurrent request just claimed it; the retry re-reads
    // (now seeing that row) and computes CYB-002.
    db.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ref: 'CYB-001' }]);

    const conflictError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['org_account_id', 'ref'] },
    });
    db.create.mockRejectedValueOnce(conflictError).mockResolvedValueOnce({
      id: 'risk-2',
      ref: 'CYB-002',
    });

    const result = await createRiskWithGeneratedRef({
      org_account_id: 'org-1',
      name: 'Test risk',
      category: 'Cyber',
      status: 'open',
      site_id: 'site-1',
    } as any);

    expect(db.create).toHaveBeenCalledTimes(2);
    expect(db.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ ref: 'CYB-001' }),
    });
    expect(db.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({ ref: 'CYB-002' }),
    });
    expect(result).toEqual({ id: 'risk-2', ref: 'CYB-002' });
  });

  it('rethrows immediately on a non-conflict error without retrying', async () => {
    db.findMany.mockResolvedValue([]);
    const otherError = new Error('DB is down');
    db.create.mockRejectedValue(otherError);

    await expect(
      createRiskWithGeneratedRef({
        org_account_id: 'org-1',
        name: 'Test risk',
        category: 'Cyber',
        status: 'open',
        site_id: 'site-1',
      } as any),
    ).rejects.toThrow('DB is down');
    expect(db.create).toHaveBeenCalledTimes(1);
  });

  it('gives up after the max retry count on persistent conflicts', async () => {
    db.findMany.mockResolvedValue([]);
    const conflictError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['org_account_id', 'ref'] },
    });
    db.create.mockRejectedValue(conflictError);

    await expect(
      createRiskWithGeneratedRef({
        org_account_id: 'org-1',
        name: 'Test risk',
        category: 'Cyber',
        status: 'open',
        site_id: 'site-1',
      } as any),
    ).rejects.toBe(conflictError);
  });
});
