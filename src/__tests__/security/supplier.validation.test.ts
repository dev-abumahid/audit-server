import { describe, expect, it } from 'vitest';
import { supplier_validations } from '../../app/modules/supplier/supplier.validation.js';

describe('supplier_validations.create_supplier', () => {
  it('accepts a minimal valid payload (name only)', () => {
    const result = supplier_validations.create_supplier.safeParse({ name: 'Acme Steel' });
    expect(result.success).toBe(true);
  });

  it('accepts a full payload including country/notes/ai_generated/source_info', () => {
    const result = supplier_validations.create_supplier.safeParse({
      name: 'Acme Steel',
      country: 'France',
      notes: 'Primary raw materials supplier',
      ai_generated: true,
      source_info: 'https://example.com/acme-suppliers-article',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty name', () => {
    const result = supplier_validations.create_supplier.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing name', () => {
    const result = supplier_validations.create_supplier.safeParse({ country: 'France' });
    expect(result.success).toBe(false);
  });

  it('rejects a name over 255 characters', () => {
    const result = supplier_validations.create_supplier.safeParse({ name: 'a'.repeat(256) });
    expect(result.success).toBe(false);
  });

  it('rejects notes over 2000 characters', () => {
    const result = supplier_validations.create_supplier.safeParse({
      name: 'Acme Steel',
      notes: 'a'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe('supplier_validations.update_supplier', () => {
  it('accepts a partial payload (all fields optional)', () => {
    const result = supplier_validations.update_supplier.safeParse({ country: 'Germany' });
    expect(result.success).toBe(true);
  });

  it('accepts an empty payload', () => {
    const result = supplier_validations.update_supplier.safeParse({});
    expect(result.success).toBe(true);
  });
});
