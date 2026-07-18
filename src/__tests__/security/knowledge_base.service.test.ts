import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { logger } from '../../app/lib/logger.js';
import { knowledge_base_service } from '../../app/modules/knowledge_base/knowledge_base.service.js';

function makeReq(body: Record<string, unknown>) {
  return { body } as never;
}

describe('knowledge_base_service.acknowledge_upload_pdf_webhook', () => {
  it('logs and echoes back the received payload without touching the database', async () => {
    const result = await knowledge_base_service.acknowledge_upload_pdf_webhook(
      makeReq({ pdf_name: 'policy.pdf', pdf_size: '1024' }),
    );

    expect(result).toEqual({ pdf_name: 'policy.pdf', pdf_size: '1024' });
    expect(logger.info).toHaveBeenCalledWith(
      { pdf_name: 'policy.pdf', pdf_size: '1024' },
      'Received PDF-to-Pinecone completion webhook',
    );
  });
});
