export const noteSwaggerDocs = {
  '/api/note': {
    get: {
      tags: ['note'],
      summary: 'Get all note',
      description: '',
      parameters: [
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
        200: { description: 'note fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },
  '/api/note/save-raw-note': {
    post: {
      tags: ['note'],
      summary: 'Save Raw Notes',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              title: 'Note Title',
              extracted_text: 'Extracted Text',
              inspectionId: 'inspectionId',
            }),
          },
        },
      },
      responses: {
        201: { description: 'note save successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/note/extract-note-from-file': {
    post: {
      tags: ['note'],
      summary: 'Extract note from any file or image and save into db',
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
                data: {
                  type: 'object',
                  example: {
                    inspectionId: 'string',
                  },
                },
              },
              required: ['file', 'data'],
            },
          },
        },
      },
      responses: {
        201: { description: 'note save successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },

  '/api/note/{id}': {
    get: {
      tags: ['note'],
      summary: 'Get single note',
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
        200: { description: 'note fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
    patch: {
      tags: ['note'],
      summary: 'Update note',
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
              title: 'Note Title',
              extracted_text: 'Extracted Text',
            }),
          },
        },
      },
      responses: {
        200: { description: 'note updated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    delete: {
      tags: ['note'],
      summary: 'Delete note',
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
        200: { description: 'note delete successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },
  '/api/note/by-inspection/{inspectionId}': {
    get: {
      tags: ['note'],
      summary: 'Get single note by inspection id',
      description: '',
      parameters: [
        {
          name: 'inspectionId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: { description: 'note fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },
};
