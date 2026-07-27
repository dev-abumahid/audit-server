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
