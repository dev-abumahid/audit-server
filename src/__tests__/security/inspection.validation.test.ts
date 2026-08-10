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

// Issue #279: inspectorProfileId was entirely absent from this schema, so
// Zod's default unknown-key stripping (request_validator.ts's
// `schema.parseAsync`) silently dropped whatever the client sent — the
// service always wrote `undefined` regardless of the request body.
describe('inspection_validations.create_inspection — inspectorProfileId', () => {
  const BASE = {
    templateId: '11111111-1111-4111-8111-111111111111',
    siteId: '22222222-2222-4222-8222-222222222222',
    questionAnswers: [],
  };

  it('accepts and preserves a valid uuid inspectorProfileId', () => {
    const result = inspection_validations.create_inspection.safeParse({
      ...BASE,
      inspectorProfileId: '33333333-3333-4333-8333-333333333333',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inspectorProfileId).toBe('33333333-3333-4333-8333-333333333333');
    }
  });

  it('allows omitting inspectorProfileId entirely (optional field)', () => {
    const result = inspection_validations.create_inspection.safeParse(BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inspectorProfileId).toBeUndefined();
    }
  });

  it('rejects a non-uuid inspectorProfileId', () => {
    const result = inspection_validations.create_inspection.safeParse({
      ...BASE,
      inspectorProfileId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });
});

// quality-bar-loop (Inspections, round 3, security finding): mediaFiles
// entries were previously z.any(), unlike Inspection.attachments, which
// already rejects javascript:/data: schemes. mediaFiles is always a
// `{ url, type }` attachment reference (see the frontend's
// CreateNewInspection.tsx/UpdateInspection.tsx), so it can get the same
// httpUrl check attachments already has.
describe('QuestionAnswerSchema.mediaFiles', () => {
  const BASE = {
    templateId: '11111111-1111-4111-8111-111111111111',
    siteId: '22222222-2222-4222-8222-222222222222',
  };

  it('accepts a valid https mediaFiles URL', () => {
    const result = inspection_validations.create_inspection.safeParse({
      ...BASE,
      questionAnswers: [
        {
          questionId: '33333333-3333-4333-8333-333333333333',
          answer: null,
          mediaFiles: [{ url: 'https://s3.example.com/photo.jpg', type: 'image' }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a javascript: URI in mediaFiles', () => {
    const result = inspection_validations.create_inspection.safeParse({
      ...BASE,
      questionAnswers: [
        {
          questionId: '33333333-3333-4333-8333-333333333333',
          answer: null,
          mediaFiles: [{ url: 'javascript:alert(1)', type: 'image' }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a data: URI in mediaFiles', () => {
    const result = inspection_validations.create_inspection.safeParse({
      ...BASE,
      questionAnswers: [
        {
          questionId: '33333333-3333-4333-8333-333333333333',
          answer: null,
          mediaFiles: [{ url: 'data:text/html,<script>alert(1)</script>', type: 'image' }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('allows omitting mediaFiles entirely', () => {
    const result = inspection_validations.create_inspection.safeParse({
      ...BASE,
      questionAnswers: [
        { questionId: '33333333-3333-4333-8333-333333333333', answer: 'plain text answer' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('does not restrict `answer` to a URL shape, since it is polymorphic across question types', () => {
    const result = inspection_validations.create_inspection.safeParse({
      ...BASE,
      questionAnswers: [
        { questionId: '33333333-3333-4333-8333-333333333333', answer: 'javascript:alert(1)' },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('inspection_validations.update_question_answer — mediaFiles', () => {
  it('accepts a valid https mediaFiles URL', () => {
    const result = inspection_validations.update_question_answer.safeParse({
      answer: null,
      mediaFiles: [{ url: 'https://s3.example.com/photo.jpg', type: 'image' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a javascript: URI in mediaFiles', () => {
    const result = inspection_validations.update_question_answer.safeParse({
      answer: null,
      mediaFiles: [{ url: 'javascript:alert(1)', type: 'image' }],
    });
    expect(result.success).toBe(false);
  });

  it('allows omitting mediaFiles entirely', () => {
    const result = inspection_validations.update_question_answer.safeParse({
      answer: 'plain text answer',
    });
    expect(result.success).toBe(true);
  });
});
