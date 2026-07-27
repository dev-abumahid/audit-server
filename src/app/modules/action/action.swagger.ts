export const actionSwaggerDocs = {
  '/api/action': {
    post: {
      tags: ['action'],
      summary: 'Create  new action',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              inspectionId: 'inspection_789012',
              siteId: 'site_345678',
              questionId: 'question_901234',
              actionTitle: 'Repair damaged safety railing',
              actionDisc:
                'The safety railing near the loading dock is damaged and requires immediate repair to prevent workplace accidents.',
              // aexa-server#244: IIA's Five Cs for a defensible finding
              // record (all optional — a plain remediation task can omit
              // these entirely).
              criteria: 'OSHA workplace safety standard, walking-working surfaces',
              condition: 'Loading dock safety railing found damaged during inspection',
              cause: 'Railing was struck by a forklift and never reported',
              effect: 'Increased risk of a fall injury near the loading dock',
              priority: 'High',
              dueDate: new Date('2026-07-15'),
              status: 'TO_DO',
              line_of_defense: 'FIRST',
              messages: [
                {
                  message: 'Issue identified during inspection.',
                },
                {
                  message: 'Assigned maintenance team to investigate.',
                },
              ],
            }),
          },
        },
      },
      responses: {
        201: { description: 'action created successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    get: {
      tags: ['action'],
      summary: 'Get all action',
      description: '',
      parameters: [
        {
          name: 'searchTerm',
          in: 'query',
          required: false,
          schema: { type: 'string' },
        },
        {
          name: 'siteId',
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
        200: { description: 'action fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },

  '/api/action/{id}': {
    get: {
      tags: ['action'],
      summary: 'Get single action',
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
        200: { description: 'action fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
    patch: {
      tags: ['action'],
      summary: 'Update action',
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
              inspectionId: 'inspection_789012',
              siteId: 'site_345678',
              questionId: 'question_901234',
              actionTitle: 'Repair damaged safety railing',
              actionDisc:
                'The safety railing near the loading dock is damaged and requires immediate repair to prevent workplace accidents.',
              priority: 'High',
              dueDate: new Date('2026-07-15'),
              status: 'TO_DO',
            }),
          },
        },
      },
      responses: {
        200: { description: 'action updated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    put: {
      tags: ['action'],
      summary: 'Update action Message',
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
              message: 'Hi sir',
            }),
          },
        },
      },
      responses: {
        200: { description: 'action updated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    delete: {
      tags: ['action'],
      summary: 'Delete action',
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
        200: { description: 'action delete successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },
};
