export const inspectionSwaggerDocs = {
  '/api/inspection': {
    post: {
      tags: ['inspection'],
      summary: 'Create  new inspection',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              templateId: '8f7d3f2f-1a4f-4a2a-b5c6-222222222222',
              siteId: '3f2f1a4f-7d8f-4c5d-a6b7-333333333333',
              questionAnswers: [
                {
                  questionId: '9c8d7e6f-5a4b-4c3d-9e8f-555555555555',
                  answer: 'Pass',
                  note: 'Everything looks good',
                  mediaFiles: [
                    {
                      url: 'https://example.com/image1.jpg',
                      type: 'image',
                    },
                  ],
                },
              ],
            }),
          },
        },
      },
      responses: {
        201: { description: 'inspection created successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    get: {
      tags: ['inspection'],
      summary: 'Get all inspection',
      description: '',
      parameters: [
        {
          name: 'status',
          in: 'query',
          schema: {
            type: 'string',
            enum: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DRAFT'],
          },
        },
        {
          name: 'searchTerm',
          in: 'query',
          schema: {
            type: 'string',
          },
        },
        {
          name: 'siteId',
          in: 'query',
          schema: {
            type: 'string',
          },
        },
        {
          name: 'page',
          in: 'query',
          schema: {
            type: 'number',
            example: 1,
          },
        },
        {
          name: 'limit',
          in: 'query',
          schema: {
            type: 'number',
            example: 10,
          },
        },
      ],
      responses: {
        200: { description: 'inspection fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },
  '/api/inspection/{id}': {
    get: {
      tags: ['inspection'],
      summary: 'Get single inspection',
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
        200: { description: 'inspection fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
    patch: {
      tags: ['inspection'],
      summary: 'Update inspection -- Only meta data',
      description: 'IN_PROGRESS, COMPLETED, CANCELLED, DRAFT',
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
              siteId: '3f2f1a4f-7d8f-4c5d-a6b7-333333333333',
              status: 'COMPLETED',
            }),
          },
        },
      },
      responses: {
        200: { description: 'inspection updated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    delete: {
      tags: ['inspection'],
      summary: 'Delete inspection',
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
        200: { description: 'inspection delete successfully' },
        401: { description: 'unauthorized' },
      },
    },
    put: {
      tags: ['inspection'],
      summary: 'Update inspection -- Only Question and answer',
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
              answer: 'Pass',
              note: 'Everything looks good',
              mediaFiles: [
                {
                  url: 'https://example.com/image1.jpg',
                  type: 'image',
                },
              ],
            }),
          },
        },
      },
      responses: {
        200: { description: 'inspection question updated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
};
