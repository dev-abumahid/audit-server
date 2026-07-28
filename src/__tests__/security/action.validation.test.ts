import { describe, expect, it } from 'vitest';
import { action_validations } from '../../app/modules/action/action.validation.js';

const BASE = {
  inspectionId: 'insp-1',
  actionTitle: 'Fix it',
  actionDisc: 'Something broke',
  priority: 'High' as const,
  dueDate: new Date().toISOString(),
  // #97: required on create (see action.validation.ts's LINE_OF_DEFENSE_ENUM
  // comment) — included in the shared BASE fixture so every other
  // create_action test in this file (attachments, assignBy, actionDisc) isn't
  // incidentally exercising the new required-field rule too.
  line_of_defense: 'FIRST' as const,
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

describe('action_validations.create_action — actionDisc (optional description)', () => {
  it('accepts a create payload with actionDisc omitted entirely — matches aexa-frontend sending undefined for a blank "Description (Optional)" field', () => {
    const { actionDisc: _actionDisc, ...withoutDisc } = BASE;
    const result = action_validations.create_action.safeParse(withoutDisc);
    expect(result.success).toBe(true);
  });

  it('still rejects a non-string actionDisc', () => {
    const result = action_validations.create_action.safeParse({ ...BASE, actionDisc: 42 });
    expect(result.success).toBe(false);
  });

  it('accepts an explicit empty string too (frontend sends undefined, not "", but the schema should not be stricter than that)', () => {
    const result = action_validations.create_action.safeParse({ ...BASE, actionDisc: '' });
    expect(result.success).toBe(true);
  });
});

describe('action_validations.update_action — actionDisc (partial)', () => {
  it('accepts a partial update with actionDisc omitted', () => {
    const result = action_validations.update_action.safeParse({ actionTitle: 'Renamed' });
    expect(result.success).toBe(true);
  });

  it('still rejects a non-string actionDisc on update', () => {
    const result = action_validations.update_action.safeParse({ actionDisc: 42 });
    expect(result.success).toBe(false);
  });
});

describe('action_validations.update_action_messages (issue #51)', () => {
  it('accepts a non-empty message', () => {
    const result = action_validations.update_action_messages.safeParse({
      message: 'Hi there',
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty message (matches actionMessageSchema's .min(1) convention)", () => {
    const result = action_validations.update_action_messages.safeParse({ message: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing message', () => {
    const result = action_validations.update_action_messages.safeParse({});
    expect(result.success).toBe(false);
  });

  // aexa-server#311
  it('accepts an omitted visibility', () => {
    const result = action_validations.update_action_messages.safeParse({ message: 'Hi there' });
    expect(result.success).toBe(true);
  });

  it.each(['INTERNAL', 'CLIENT_VISIBLE'])('accepts visibility: %s', (visibility) => {
    const result = action_validations.update_action_messages.safeParse({
      message: 'Hi there',
      visibility,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid visibility value', () => {
    const result = action_validations.update_action_messages.safeParse({
      message: 'Hi there',
      visibility: 'PUBLIC',
    });
    expect(result.success).toBe(false);
  });
});

// Issue #97: Three Lines of Defense classification. Unlike Risk/Kri/
// ComplianceObligation/AuditEngagement (all optional on create, with a
// schema-level DB default), Action has no default — see action.prisma's
// line_of_defense comment — so create_action requires it explicitly while
// update_action keeps it optional (existing Actions must not be forced
// through this requirement on an unrelated PATCH).
describe('action_validations.create_action — line_of_defense (#97, required on create)', () => {
  it('rejects a create payload with line_of_defense omitted', () => {
    const { line_of_defense: _lod, ...withoutLod } = BASE;
    const result = action_validations.create_action.safeParse(withoutLod);
    expect(result.success).toBe(false);
  });

  it('accepts FIRST/SECOND/THIRD', () => {
    for (const value of ['FIRST', 'SECOND', 'THIRD']) {
      const result = action_validations.create_action.safeParse({
        ...BASE,
        line_of_defense: value,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an invalid line_of_defense value', () => {
    const result = action_validations.create_action.safeParse({
      ...BASE,
      line_of_defense: 'FOURTH',
    });
    expect(result.success).toBe(false);
  });
});

describe('action_validations.update_action — line_of_defense (#97, optional on update)', () => {
  it('accepts a partial update with line_of_defense omitted — existing Actions are never forced to classify via an unrelated PATCH', () => {
    const result = action_validations.update_action.safeParse({ actionTitle: 'Renamed' });
    expect(result.success).toBe(true);
  });

  it('accepts a valid line_of_defense on its own', () => {
    const result = action_validations.update_action.safeParse({ line_of_defense: 'SECOND' });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid line_of_defense value on update too', () => {
    const result = action_validations.update_action.safeParse({ line_of_defense: 'FOURTH' });
    expect(result.success).toBe(false);
  });
});
