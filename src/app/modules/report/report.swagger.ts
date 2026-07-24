export const reportSwaggerDocs = {
  '/api/report/generate': {
    post: {
      tags: ['report'],
      summary: 'Generate a Board Report (synchronous)',
      description:
        "Fetches the org's Risk/KRI/Site/Action data, calls aexa-ai for structured " +
        'board-report content, renders it to PDF, uploads it, and creates a Report row. ' +
        'Runs synchronously (up to ~120s). Returns the Report at status READY on success ' +
        'or FAILED if any pipeline step fails.',
      requestBody: {
        required: false,
        content: {
          'application/json': {
            example: JSON.stringify({ type: 'BOARD', title: 'Q3 2026 Board Report' }),
          },
        },
      },
      responses: {
        200: { description: 'Report generated (status READY or FAILED)' },
        400: { description: 'Unsupported report type' },
        403: { description: 'Caller lacks write permission' },
      },
    },
  },
  '/api/report': {
    get: {
      tags: ['report'],
      summary: 'List the org reports (paginated)',
      parameters: [
        { name: 'searchTerm', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
      ],
      responses: { 200: { description: 'Reports fetched successfully' } },
    },
  },
  '/api/report/{id}': {
    get: {
      tags: ['report'],
      summary: 'Get a single report (org-scoped)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Report fetched successfully' },
        404: { description: 'Report not found' },
      },
    },
  },
  '/api/report/{id}/download': {
    get: {
      tags: ['report'],
      summary: 'Get the report PDF download URL',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Download URL fetched successfully' },
        404: { description: 'Report not found' },
        409: { description: 'Report is not ready for download' },
      },
    },
  },
  '/api/report/{id}/publish': {
    patch: {
      tags: ['report'],
      summary: 'Publish a report (org-admin only, READY -> PUBLISHED)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Report published successfully' },
        403: { description: 'Only organization admins can publish' },
        404: { description: 'Report not found' },
        409: { description: 'Report is not in READY state' },
      },
    },
  },
};
