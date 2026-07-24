export const auditSwaggerDocs = {
  '/api/audit': {
    post: {
      tags: ['audit'],
      summary: 'Create new audit engagement',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              ref: 'AUD-2026-001',
              title: 'Supply Chain Risk Audit',
              scope: 'Review of supplier dependencies and logistics processes',
              status: 'in_progress',
              lead_auditor: 'John Doe',
              priority_score: 85,
              findings_count: 3,
              started_at: '2026-03-01T09:00:00Z',
              closed_at: null,
              linked_risk_refs: ['RISK-001'],
            }),
          },
        },
      },
      responses: {
        200: { description: 'audit engagement created successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    get: {
      tags: ['audit'],
      summary: 'Get all audit engagements',
      description: '',
      parameters: [
        {
          name: 'searchTerm',
          in: 'query',
          required: false,
          schema: { type: 'string' },
        },
        {
          name: 'page',
          in: 'query',
          required: false,
          schema: { type: 'number' },
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'number' },
        },
      ],
      responses: {
        200: { description: 'audit engagements fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },

  '/api/audit/{id}': {
    get: {
      tags: ['audit'],
      summary: 'Get single audit engagement',
      description: '',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: { description: 'audit engagement fetched successfully' },
        401: { description: 'unauthorized' },
        404: { description: 'audit engagement not found' },
      },
    },
    patch: {
      tags: ['audit'],
      summary: 'Update audit engagement',
      description: '',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              title: 'Supply Chain Risk Audit (revised)',
              status: 'completed',
              findings_count: 4,
            }),
          },
        },
      },
      responses: {
        200: { description: 'audit engagement updated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    delete: {
      tags: ['audit'],
      summary: 'Delete audit engagement',
      description: '',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: { description: 'audit engagement deleted successfully' },
        401: { description: 'unauthorized' },
        404: { description: 'audit engagement not found' },
      },
    },
  },
};
