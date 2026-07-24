import { describe, expect, it } from 'vitest';
import { audit_validations } from '../../app/modules/audit/audit.validation.js';

const VALID_CREATE = {
  ref: 'AUD-2026-001',
  title: 'Q3 Internal Audit',
  status: 'planned',
};

describe('audit_validations.create_audit — required fields (issue #197)', () => {
  it('accepts a payload with ref, title and status', () => {
    const result = audit_validations.create_audit.safeParse(VALID_CREATE);
    expect(result.success).toBe(true);
  });

  it('rejects a missing ref (maps to a NOT NULL column — would otherwise 500 at Prisma)', () => {
    const { ref: _omitted, ...noRef } = VALID_CREATE;
    const result = audit_validations.create_audit.safeParse(noRef);
    expect(result.success).toBe(false);
  });

  it('rejects an empty-string ref', () => {
    const result = audit_validations.create_audit.safeParse({ ...VALID_CREATE, ref: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty-string title (would otherwise persist a blank-titled row)', () => {
    const result = audit_validations.create_audit.safeParse({ ...VALID_CREATE, title: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing title', () => {
    const { title: _omitted, ...noTitle } = VALID_CREATE;
    const result = audit_validations.create_audit.safeParse(noTitle);
    expect(result.success).toBe(false);
  });

  it('coerces an ISO date string on started_at/closed_at', () => {
    const result = audit_validations.create_audit.safeParse({
      ...VALID_CREATE,
      started_at: '2026-01-01',
      closed_at: '2026-03-01',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.started_at).toBeInstanceOf(Date);
      expect(result.data.closed_at).toBeInstanceOf(Date);
    }
  });

  it('treats an empty-string date as no date (undefined) on create', () => {
    const result = audit_validations.create_audit.safeParse({
      ...VALID_CREATE,
      closed_at: '',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.closed_at).toBeUndefined();
    }
  });
});

describe('audit_validations.update_audit — date clearing (issue #198)', () => {
  it('passes an explicit null through as null so a set date can be CLEARED', () => {
    // This is the core of the bug: the frontend sends `closed_at: null` to
    // clear a previously-set date. The create-style preprocessor turned that
    // into undefined ("leave unchanged"), so the clear silently never
    // persisted. On the update schema, null must survive as null so Prisma
    // writes NULL to the column.
    const result = audit_validations.update_audit.safeParse({ closed_at: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('closed_at' in result.data).toBe(true);
      expect(result.data.closed_at).toBeNull();
    }
  });

  it('passes an empty-string date through as null (clear) on update', () => {
    const result = audit_validations.update_audit.safeParse({ started_at: '' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.started_at).toBeNull();
    }
  });

  it('leaves an omitted date as undefined ("leave unchanged"), NOT null', () => {
    const result = audit_validations.update_audit.safeParse({ title: 'Renamed' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.closed_at).toBeUndefined();
      expect(result.data.started_at).toBeUndefined();
    }
  });

  it('still coerces a real date value on update', () => {
    const result = audit_validations.update_audit.safeParse({ closed_at: '2026-05-01' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.closed_at).toBeInstanceOf(Date);
    }
  });

  it('allows a partial update with no required fields (PATCH semantics preserved)', () => {
    const result = audit_validations.update_audit.safeParse({ status: 'completed' });
    expect(result.success).toBe(true);
  });
});
