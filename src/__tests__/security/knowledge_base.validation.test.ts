import { describe, expect, it } from 'vitest';
import { knowledge_base_validations } from '../../app/modules/knowledge_base/knowledge_base.validation.js';

describe('knowledge_base_validations.upload_pdf_webhook', () => {
  it('accepts a valid payload', () => {
    const result = knowledge_base_validations.upload_pdf_webhook.safeParse({
      pdf_name: 'policy.pdf',
      pdf_size: '1024',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing field', () => {
    const result = knowledge_base_validations.upload_pdf_webhook.safeParse({
      pdf_name: 'policy.pdf',
    });
    expect(result.success).toBe(false);
  });
});
