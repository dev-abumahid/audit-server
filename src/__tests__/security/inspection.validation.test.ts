import { describe, expect, it } from 'vitest';
import { inspection_validations } from '../../app/modules/inspection/inspection.validation.js';

describe('inspection_validations.update_inspection — attachments', () => {
  it('accepts a valid https URL', () => {
    const result = inspection_validations.update_inspection.safeParse({
      attachments: ['https://s3.example.com/file.jpg'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a javascript: URI', () => {
    const result = inspection_validations.update_inspection.safeParse({
      attachments: ['javascript:alert(1)'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a data: URI', () => {
    const result = inspection_validations.update_inspection.safeParse({
      attachments: ['data:text/html,<script>alert(1)</script>'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 10 attachments', () => {
    const result = inspection_validations.update_inspection.safeParse({
      attachments: Array.from({ length: 11 }, (_, i) => `https://s3.example.com/${i}.jpg`),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an attachment URL longer than 2048 characters', () => {
    const result = inspection_validations.update_inspection.safeParse({
      attachments: [`https://s3.example.com/${'a'.repeat(2048)}.jpg`],
    });
    expect(result.success).toBe(false);
  });

  it('allows omitting attachments entirely', () => {
    const result = inspection_validations.update_inspection.safeParse({
      status: 'COMPLETED',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an explicit empty array (clears attachments)', () => {
    const result = inspection_validations.update_inspection.safeParse({
      attachments: [],
    });
    expect(result.success).toBe(true);
  });
});
