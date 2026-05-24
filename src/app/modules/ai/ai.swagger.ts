export const aiSwaggerDocs = {
  '/api/ai/generate-with-prompt': {
    post: {
      tags: ['AI Routes'],
      summary: 'Generate template with prompt',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              prompt: 'Generate a template for a risk assessment report.',
            }),
          },
        },
      },
      responses: {
        201: { description: 'Template generated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/ai/generate-with-pdf': {
    post: {
      tags: ['AI Routes'],
      summary: 'Generate template with PDF',
      description: '',
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                file: {
                  type: 'string',
                  format: 'binary',
                },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Template generated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/ai/generate-with-risk': {
    post: {
      tags: ['AI Routes'],
      summary: 'Generate template with risk',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                riskId: {
                  type: 'string',
                },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Template generated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/ai/generate-recommendation': {
    post: {
      tags: ['AI Routes'],
      summary: 'Generate recommendation with inspection',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                inspectionId: {
                  type: 'string',
                },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Template generated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
};
