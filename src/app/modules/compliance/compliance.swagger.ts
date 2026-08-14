export const complianceSwaggerDocs = {
  '/api/compliance': {
    post: {
      tags: ['compliance'],
      summary: 'Create new compliance obligation',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              title: 'GDPR Article 30 records of processing',
              description: 'Maintain and keep current the records of processing activities.',
              domain: 'Data Protection',
              site_id: null,
              status: 'in_progress',
              owner: 'Jane Doe',
              due_date: '2026-12-31T00:00:00Z',
              attachments: [],
              regulation_reference: 'GDPR Art. 30(1)',
              // aexa-server#250: declared re-attestation cadence. Omitted =
              // non-recurring. next_review_date is derived (seeded from
              // due_date here, then advanced by POST /:id/attest) — never
              // client-settable.
              recurrence: 'annual',
            }),
          },
        },
      },
      responses: {
        200: { description: 'compliance obligation created successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    get: {
      tags: ['compliance'],
      summary: 'Get all compliance obligations',
      description: '',
      parameters: [
        { name: 'searchTerm', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'status', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'domain', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'page', in: 'query', required: false, schema: { type: 'number' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'number' } },
      ],
      responses: {
        200: { description: 'compliance obligations fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },

  '/api/compliance/scorecard': {
    get: {
      tags: ['compliance'],
      summary:
        'Compute the org compliance scorecard (overall, by domain, by site, site×domain matrix)',
      description: '',
      responses: {
        200: { description: 'compliance scorecard computed successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },

  '/api/compliance/attachment': {
    post: {
      tags: ['compliance'],
      summary: 'Upload a compliance-evidence attachment, returns its URL',
      description:
        'Two-step flow: upload here, then include the returned URL in the obligation attachments array.',
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: { file: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
      responses: {
        200: { description: 'attachment uploaded successfully' },
        400: { description: 'file is required or file type not allowed' },
        401: { description: 'unauthorized' },
      },
    },
  },

  '/api/compliance/{id}/attest': {
    post: {
      tags: ['compliance'],
      summary: 'Re-attest a compliance obligation',
      description:
        'Records a permanent re-attestation entry (who, when, the status at that moment, an optional note) and, if the obligation has a declared recurrence, advances next_review_date by that cadence.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            example: JSON.stringify({ note: 'Confirmed with legal counsel' }),
          },
        },
      },
      responses: {
        200: { description: 'compliance obligation re-attested successfully' },
        401: { description: 'unauthorized' },
        404: { description: 'compliance obligation not found' },
      },
    },
  },

  '/api/compliance/{id}/attestations': {
    get: {
      tags: ['compliance'],
      summary: "Get a compliance obligation's re-attestation history",
      description: 'Returns every recorded attestation for this obligation, newest first.',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'page', in: 'query', required: false, schema: { type: 'number' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'number' } },
      ],
      responses: {
        200: { description: 'compliance attestation history fetched successfully' },
        401: { description: 'unauthorized' },
        404: { description: 'compliance obligation not found' },
      },
    },
  },

  '/api/compliance/{id}/edit-history': {
    get: {
      tags: ['compliance'],
      summary: "Get a compliance obligation's edit history",
      description:
        'Returns every recorded field-level edit (title/description/domain/site_id/status/owner/due_date/regulation_reference/recurrence/line_of_defense) for this obligation, newest first. Distinct from /attestations, which logs re-confirmation events rather than edits.',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'page', in: 'query', required: false, schema: { type: 'number' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'number' } },
      ],
      responses: {
        200: { description: 'compliance edit history fetched successfully' },
        401: { description: 'unauthorized' },
        404: { description: 'compliance obligation not found' },
      },
    },
  },

  '/api/compliance/{id}': {
    get: {
      tags: ['compliance'],
      summary: 'Get single compliance obligation',
      description: '',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'compliance obligation fetched successfully' },
        401: { description: 'unauthorized' },
        404: { description: 'compliance obligation not found' },
      },
    },
    patch: {
      tags: ['compliance'],
      summary: 'Update compliance obligation',
      description: '',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            // aexa-server#243: setting status: 'compliant' now requires at
            // least one attachment (either supplied here or already present
            // on the row) — see compliance.service.ts's
            // assertCompliantHasEvidence.
            example: JSON.stringify({
              status: 'compliant',
              is_edited: true,
              attachments: ['https://res.cloudinary.com/demo/raw/upload/v1/evidence.pdf'],
            }),
          },
        },
      },
      responses: {
        200: { description: 'compliance obligation updated successfully' },
        400: { description: 'compliant status requires at least one evidence attachment' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    delete: {
      tags: ['compliance'],
      summary: 'Delete compliance obligation',
      description: '',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'compliance obligation deleted successfully' },
        401: { description: 'unauthorized' },
        404: { description: 'compliance obligation not found' },
      },
    },
  },
};
