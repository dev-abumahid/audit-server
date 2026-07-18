import { describe, expect, it } from 'vitest';
import { note_validations } from '../../app/modules/note/note.validation.js';

describe('note_validations.update_note — attachments', () => {
  it('accepts a valid https URL', () => {
    const result = note_validations.update_note.safeParse({
      attachments: ['https://s3.example.com/file.jpg'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a javascript: URI', () => {
    const result = note_validations.update_note.safeParse({
      attachments: ['javascript:alert(1)'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a data: URI', () => {
    const result = note_validations.update_note.safeParse({
      attachments: ['data:text/html,<script>alert(1)</script>'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 10 attachments', () => {
    const result = note_validations.update_note.safeParse({
      attachments: Array.from({ length: 11 }, (_, i) => `https://s3.example.com/${i}.jpg`),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an attachment URL longer than 2048 characters', () => {
    const result = note_validations.update_note.safeParse({
      attachments: [`https://s3.example.com/${'a'.repeat(2048)}.jpg`],
    });
    expect(result.success).toBe(false);
  });

  it('allows omitting attachments entirely', () => {
    const result = note_validations.update_note.safeParse({ title: 'New title' });
    expect(result.success).toBe(true);
  });

  it('accepts an explicit empty array (clears attachments)', () => {
    const result = note_validations.update_note.safeParse({ attachments: [] });
    expect(result.success).toBe(true);
  });
});
