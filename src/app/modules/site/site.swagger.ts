export const siteSwaggerDocs = {
  '/api/site': {
    post: {
      tags: ['site'],
      summary: 'Create  new site',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              name: 'Dhaka Manufacturing Unit',
              location: 'Gazipur',
              country: 'BD',
              activity: 'Garment Production',
              revenue: 5000000,
              employees_count: 250,
              site_type: 'factory',
              lat: 23.9999,
              lng: 90.4203,
            }),
          },
        },
      },
      responses: {
        201: { description: 'site created successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    get: {
      tags: ['site'],
      summary: 'Get all site',
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
        200: { description: 'site fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },

  '/api/site/{id}': {
    get: {
      tags: ['site'],
      summary: 'Get single site',
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
        200: { description: 'site fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
    patch: {
      tags: ['site'],
      summary: 'Update site',
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
              name: 'Dhaka Manufacturing Unit',
              location: 'Gazipur',
              country: 'BD',
              activity: 'Garment Production',
              revenue: 5000000,
              employees_count: 250,
              site_type: 'factory',
              lat: 23.9999,
              lng: 90.4203,
            }),
          },
        },
      },
      responses: {
        200: { description: 'site updated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    delete: {
      tags: ['site'],
      summary: 'Delete site',
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
        200: { description: 'site delete successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },
};
