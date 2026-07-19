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
  '/api/ai/upload-pdf-into-pinecone': {
    post: {
      tags: ['AI Routes'],
      summary: 'Upload PDF into pinecone',
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
              required: ['file'],
            },
          },
        },
      },
      responses: {
        201: {
          description: 'PDF uploaded successfully',
        },
        500: {
          description: 'Validation error or internal server error',
        },
      },
    },
  },
  '/api/ai/get-all-files-from-pinecone': {
    get: {
      tags: ['AI Routes'],
      summary: 'Get all files from pinecone',
      description: '',
      responses: {
        201: {
          description: 'PDF uploaded successfully',
        },
        500: {
          description: 'Validation error or internal server error',
        },
      },
    },
  },
  '/api/ai/delete-file-from-pinecone/{fileName}': {
    delete: {
      tags: ['AI Routes'],
      summary: 'Delete file from pinecone',
      description: '',
      parameters: [
        {
          name: 'fileName',
          in: 'query',
          required: true,
          schema: {
            type: 'string',
          },
        },
      ],
      responses: {
        200: {
          description: 'PDF deleted successfully',
        },
        500: {
          description: 'Validation error or internal server error',
        },
      },
    },
  },
  '/api/ai/check-upload-file-status/{fileId}': {
    get: {
      tags: ['AI Routes'],
      summary: 'Check uploaded file status',
      description: '',
      parameters: [
        {
          name: 'fileId',
          in: 'path',
          required: true,
          schema: {
            type: 'string',
          },
        },
      ],
      responses: {
        200: {
          description: 'File Status fetch successful',
        },
        500: {
          description: 'Validation error or internal server error',
        },
      },
    },
  },
};
