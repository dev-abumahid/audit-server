export const kriSwaggerDocs = {
  '/api/kri': {
    post: {
      tags: ['kri'],
      summary: 'Create new KRI',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              risk_id: '',
              name: 'Supplier Lead Time',
              owner: 'Jane Procurement',
              unit: 'days',
              current_value: 25,
              alert_threshold: 30,
              target_value: 20,
              frequency: 'weekly',
            }),
          },
        },
      },
      responses: {
        200: { description: 'KRI created successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    get: {
      tags: ['kri'],
      summary: 'Get all KRIs',
      description: '',
      parameters: [
        { name: 'risk_id', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'page', in: 'query', required: false, schema: { type: 'number' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'number' } },
      ],
      responses: {
        200: { description: 'KRIs fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },

  '/api/kri/{id}': {
    get: {
      tags: ['kri'],
      summary: 'Get single KRI',
      description: '',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'KRI fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
    patch: {
      tags: ['kri'],
      summary: 'Update KRI',
      description: '',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              name: 'Supplier Lead Time',
              owner: 'Jane Procurement',
              unit: 'days',
              alert_threshold: 30,
              target_value: 20,
              frequency: 'weekly',
            }),
          },
        },
      },
      responses: {
        200: { description: 'KRI updated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    delete: {
      tags: ['kri'],
      summary: 'Delete KRI',
      description: '',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'KRI deleted successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },

  '/api/kri/{id}/value': {
    post: {
      tags: ['kri'],
      summary: 'Submit a new KRI reading',
      description:
        'Updates current_value and records it as a permanent KriReading history entry. On a status transition, creates an Alert: high severity into ALERT, medium into WARNING, low (informational) on recovery into OK.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({ current_value: 42 }),
          },
        },
      },
      responses: {
        200: { description: 'KRI value recorded successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },

  '/api/kri/{id}/readings': {
    get: {
      tags: ['kri'],
      summary: "Get a KRI's reading history",
      description:
        'Returns every recorded value for this KRI (including the initial value it was created with), newest first.',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'page', in: 'query', required: false, schema: { type: 'number' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'number' } },
      ],
      responses: {
        200: { description: 'KRI reading history fetched successfully' },
        401: { description: 'unauthorized' },
        404: { description: 'KRI not found' },
      },
    },
  },
};
