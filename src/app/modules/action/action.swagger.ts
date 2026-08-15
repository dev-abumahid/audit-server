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
          name: 'auditEngagementId',
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

  // aexa-server#252: finding closure maker-checker workflow. A finding only
  // ever reaches status COMPLETE/CANT_DO via an approved closure request —
  // a direct PATCH /action/:id with either status is rejected (400).
  '/api/action/{id}/closure/submit': {
    post: {
      tags: ['action'],
      summary: 'Submit a finding for closure',
      description:
        "Requests a terminal status (COMPLETE or CANT_DO). Requires at least one attachment on the finding. Does not change the finding's status — only an approved closure request does.",
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({ requestedStatus: 'COMPLETE' }),
          },
        },
      },
      responses: {
        200: { description: 'finding submitted for closure successfully' },
        400: { description: 'invalid requestedStatus, or no evidence attachment' },
        401: { description: 'unauthorized' },
        404: { description: 'action not found' },
        409: { description: 'a closure request is already live for this finding' },
      },
    },
  },

  '/api/action/{id}/closure': {
    get: {
      tags: ['action'],
      summary: "Get a finding's closure state",
      description: '',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'finding closure state fetched successfully' },
        401: { description: 'unauthorized' },
        404: { description: 'action not found' },
      },
    },
  },

  '/api/action/closure/{id}/approve': {
    post: {
      tags: ['action'],
      summary: 'Approve a finding closure request',
      description:
        'ADMIN/LEAD_AUDITOR only, and never the same person who submitted the request. Atomically applies the requested status to the finding.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'finding closure approved successfully' },
        400: { description: 'not pending, or invalidated by an edit since submission' },
        401: { description: 'unauthorized' },
        403: { description: 'self-approval, or insufficient role' },
        404: { description: 'closure request not found' },
        409: { description: 'already decided or invalidated by another request' },
      },
    },
  },

  '/api/action/closure/{id}/reject': {
    post: {
      tags: ['action'],
      summary: 'Reject a finding closure request',
      description:
        'ADMIN/LEAD_AUDITOR only, and never the same person who submitted the request. Requires a decisionNote. The finding is left untouched (it was never advanced while pending).',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({ decisionNote: 'Evidence insufficient — please redo.' }),
          },
        },
      },
      responses: {
        200: { description: 'finding closure rejected successfully' },
        400: { description: 'missing decisionNote, not pending, or invalidated by an edit' },
        401: { description: 'unauthorized' },
        403: { description: 'self-rejection, or insufficient role' },
        404: { description: 'closure request not found' },
        409: { description: 'already decided or invalidated by another request' },
      },
    },
  },
};
