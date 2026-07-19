import { describe, expect, it } from 'vitest';
import { action_validations } from '../../app/modules/action/action.validation.js';

const BASE = {
  inspectionId: 'insp-1',
  actionTitle: 'Fix it',
  actionDisc: 'Something broke',
  priority: 'High' as const,
  dueDate: new Date().toISOString(),
};

describe('action_validations.create_action — attachments', () => {
  it('accepts a valid https URL', () => {
    const result = action_validations.create_action.safeParse({
      ...BASE,
      attachments: ['https://s3.example.com/file.jpg'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a javascript: URI', () => {
    const result = action_validations.create_action.safeParse({
      ...BASE,
      attachments: ['javascript:alert(1)'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a data: URI', () => {
    const result = action_validations.create_action.safeParse({
      ...BASE,
      attachments: ['data:text/html,<script>alert(1)</script>'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 10 attachments', () => {
    const result = action_validations.create_action.safeParse({
      ...BASE,
      attachments: Array.from({ length: 11 }, (_, i) => `https://s3.example.com/${i}.jpg`),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an attachment URL longer than 2048 characters', () => {
    const result = action_validations.create_action.safeParse({
      ...BASE,
      attachments: [`https://s3.example.com/${'a'.repeat(2048)}.jpg`],
    });
    expect(result.success).toBe(false);
  });

  it('allows omitting attachments entirely', () => {
    const result = action_validations.create_action.safeParse(BASE);
    expect(result.success).toBe(true);
  });
});

describe('action_validations.update_action — attachments (partial)', () => {
  it('rejects a javascript: URI on a partial update too', () => {
    const result = action_validations.update_action.safeParse({
      attachments: ['javascript:alert(1)'],
    });
    expect(result.success).toBe(false);
  });
});

describe('action_validations.create_action — assignBy (issue #52)', () => {
  it('accepts an array of member ids', () => {
    const result = action_validations.create_action.safeParse({
      ...BASE,
      assignBy: ['member-1', 'member-2'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty array', () => {
    const result = action_validations.create_action.safeParse({ ...BASE, assignBy: [] });
    expect(result.success).toBe(true);
  });

  it('allows omitting assignBy entirely', () => {
    const result = action_validations.create_action.safeParse(BASE);
    expect(result.success).toBe(true);
  });

  it('rejects an empty-string id', () => {
    const result = action_validations.create_action.safeParse({
      ...BASE,
      assignBy: [''],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 20 assignees', () => {
    const result = action_validations.create_action.safeParse({
      ...BASE,
      assignBy: Array.from({ length: 21 }, (_, i) => `member-${i}`),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a duplicate id (would otherwise hit the DB unique constraint as a raw 500)', () => {
    const result = action_validations.create_action.safeParse({
      ...BASE,
      assignBy: ['member-1', 'member-1'],
    });
    expect(result.success).toBe(false);
  });

  it('allows the same id to NOT repeat', () => {
    const result = action_validations.create_action.safeParse({
      ...BASE,
      assignBy: ['member-1', 'member-2'],
    });
    expect(result.success).toBe(true);
  });
});

describe('action_validations.update_action — assignBy (partial, issue #52)', () => {
  it('accepts assignBy on its own with no other fields', () => {
    const result = action_validations.update_action.safeParse({ assignBy: ['member-1'] });
    expect(result.success).toBe(true);
  });

  it('rejects more than 20 assignees on a partial update too', () => {
    const result = action_validations.update_action.safeParse({
      assignBy: Array.from({ length: 21 }, (_, i) => `member-${i}`),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a duplicate id on a partial update too', () => {
    const result = action_validations.update_action.safeParse({
      assignBy: ['member-1', 'member-1'],
    });
    expect(result.success).toBe(false);
  });
});
