export const templateSwaggerDocs = {
  '/api/template': {
    post: {
      tags: ['template'],
      summary: 'Create new template',
      description: 'Create template with JSON data and file upload',
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  description: 'Stringified JSON payload of template',
                  example: JSON.stringify({
                    templateLogo: 'https://example.com/logo.png',
                    templateName: 'Safety Inspection Template',
                    templateDisc: 'Daily safety inspection checklist',
                    pages: [
                      {
                        pageIndex: 0,
                        title: 'General Information',
                        questions: [
                          {
                            index: 0,
                            question: 'Inspector Name',
                            isRequired: true,
                            answerType: {
                              answerType: 'input',
                              value: 'John Doe',
                            },
                          },
                          {
                            index: 1,
                            question: 'Inspection Date',
                            isRequired: true,
                            answerType: {
                              answerType: 'date',
                              value: '2022-01-01',
                            },
                          },
                        ],
                      },
                    ],
                    access: [
                      { userId: 'user_001', userName: 'John Doe' },
                      { userId: 'user_002', userName: 'Jane Doe' },
                    ],
                  }),
                },
                file: {
                  type: 'string',
                  format: 'binary',
                  description: 'Any file upload (image/pdf/etc)',
                },
              },
              required: ['data'],
            },
          },
        },
      },
      responses: {
        201: { description: 'Template created successfully' },
        400: { description: 'Validation error' },
        500: { description: 'Internal server error' },
      },
    },
    get: {
      tags: ['template'],
      summary: 'Get all template',
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
        {
          name: 'category',
          in: 'query',
          required: false,
          schema: { type: 'string' },
          description: 'Exact-match filter on the template category',
        },
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['DRAFT', 'PUBLISHED'] },
          description: 'Exact-match filter on draft/publish status',
        },
      ],
      responses: {
        200: { description: 'template fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },
  '/api/template/categories': {
    get: {
      tags: ['template'],
      summary: "List the caller org's distinct template categories",
      description:
        'Flat list of distinct, non-null category values already used in this org, for a suggest-from-existing-values UI (not a managed taxonomy).',
      responses: {
        200: { description: 'template categories fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },
  '/api/template/{id}': {
    get: {
      tags: ['template'],
      summary: 'Get single template',
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
        200: { description: 'template fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
    patch: {
      tags: ['template'],
      summary: 'Update template',
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
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  description: 'Stringified JSON payload of template',
                  example: JSON.stringify({
                    templateName: 'Safety Inspection Template',
                    templateDisc: 'Daily safety inspection checklist',
                  }),
                },
                file: {
                  type: 'string',
                  format: 'binary',
                  description: 'Any file upload (image/pdf/etc)',
                },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'template updated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    delete: {
      tags: ['template'],
      summary: 'Delete template',
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
        200: { description: 'template delete successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },
  '/api/template/{id}/duplicate': {
    post: {
      tags: ['template'],
      summary: 'Duplicate a template, including all of its pages and questions',
      description:
        'Creates a new template in the caller org as a copy of the source template (name suffixed with " (copy)"). Access grants are not copied -- the duplicate starts private.',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: { description: 'template duplicated successfully' },
        401: { description: 'unauthorized' },
        403: { description: 'forbidden -- caller cannot write org resources' },
        404: { description: 'template not found' },
      },
    },
  },
  '/api/template/update-or-create-new-page': {
    patch: {
      tags: ['template [page]'],
      summary: 'Update or Create new Page Into Template',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                pageId: {
                  type: 'string',
                  example: '60911398-8b4a-4064-ba54-3d769f836897',
                },
                pageIndex: {
                  type: 'number',
                  example: 1,
                },
                title: {
                  type: 'string',
                  example: 'This is another page',
                },
                templateId: {
                  type: 'string',
                  example: '60911398-8b4a-4064-ba54-3d769f836897',
                },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'template updated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/template/delete-template-page/{id}': {
    delete: {
      tags: ['template [page]'],
      summary: 'Delete Page form Templates',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: { description: 'template page delete successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/template/update-or-create-new-question': {
    patch: {
      tags: ['template [question]'],
      summary: 'Update or Create new Question Into Pages',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              index: 1,
              question: 'How to learn bangla?',
              isRequired: true,
              answerType: {
                answerType: 'input',
                value: '',
              },
              pageId: '',
              questionId: '',
            }),
          },
        },
      },
      responses: {
        200: { description: 'template updated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/template/delete-page-question/{id}': {
    delete: {
      tags: ['template [question]'],
      summary: 'Delete Question form Pages',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: { description: 'page question delete successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/template/send-template-access-invitation': {
    post: {
      tags: ['template [access]'],
      summary: 'Send Template Access Invitation',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              templateId: '',
              userId: '',
            }),
          },
        },
      },
      responses: {
        200: { description: 'page question delete successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/template/remove-template-access': {
    delete: {
      tags: ['template [access]'],
      summary: 'Remove Template Access',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              templateId: '',
              userId: '',
            }),
          },
        },
      },
      responses: {
        200: { description: 'page question delete successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
};
