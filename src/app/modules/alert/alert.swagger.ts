export const alertSwaggerDocs = {
  '/api/alert': {
    post: {
      tags: ['alert'],
      summary: 'Create new alert (manual)',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              source: 'Manual',
              type: 'Operational',
              severity: 'high',
              title: 'Unusual spike in failed login attempts',
              description: 'Unusual spike in failed login attempts across accounts.',
              kri_id: '',
            }),
          },
        },
      },
      responses: {
        200: { description: 'alert created successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    get: {
      tags: ['alert'],
      summary: 'Get all alerts',
      description: '',
      parameters: [
        { name: 'severity', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'is_read', in: 'query', required: false, schema: { type: 'boolean' } },
        { name: 'kri_id', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'page', in: 'query', required: false, schema: { type: 'number' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'number' } },
      ],
      responses: {
        200: { description: 'alerts fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },

  '/api/alert/{id}': {
    get: {
      tags: ['alert'],
      summary: 'Get single alert',
      description: '',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'alert fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
    delete: {
      tags: ['alert'],
      summary: 'Delete alert',
      description: '',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'alert deleted successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },

  '/api/alert/{id}/read': {
    patch: {
      tags: ['alert'],
      summary: 'Mark alert read/unread',
      description: '',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({ is_read: true }),
          },
        },
      },
      responses: {
        200: { description: 'alert updated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
};
