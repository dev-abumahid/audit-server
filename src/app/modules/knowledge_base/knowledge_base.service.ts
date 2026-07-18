import { Request } from 'express';
import { logger } from '../../lib/logger.js';

/**
 * Called by aexa-ai's notify_webhook() (upload_pdf_to_pinecone.py) once
 * PDF-to-Pinecone embedding finishes — see #96.
 *
 * Deliberately does NOT write to PineconeDocument here. That record is
 * already created synchronously in ai.service.ts's
 * upload_pdf_into_pinecone_via_ai, at the point the initial upload request
 * gets back a file_id from aexa-ai — before the async embedding work this
 * webhook confirms even starts. This webhook's payload ({pdf_name, pdf_size})
 * carries no org/account identifier at all (unlike /api/notification's
 * orgUserName), and fileName is not unique across orgs — matching on it
 * alone to decide which org's record to touch would be exactly the
 * cross-tenant risk this repo's org-scoping rule exists to prevent
 * (CLAUDE.md: "Missing org scope = cross-tenant data leak. PRs that add
 * queries without org scoping will be rejected.").
 *
 * This route's job for now is narrower: exist (so aexa-ai's webhook call
 * stops silently 404ing) and acknowledge receipt with a 200. Actually
 * persisting a completion signal against the right org's record needs
 * aexa-ai's payload to carry an org identifier first — tracked as a
 * follow-up on the aexa-ai side.
 */
const acknowledge_upload_pdf_webhook = async (req: Request) => {
  const { pdf_name, pdf_size } = req.body;
  logger.info({ pdf_name, pdf_size }, 'Received PDF-to-Pinecone completion webhook');
  return { pdf_name, pdf_size };
};

export const knowledge_base_service = {
  acknowledge_upload_pdf_webhook,
};
