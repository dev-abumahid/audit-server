export const riskSwaggerDocs = {
  '/api/risk': {
    post: {
      tags: ['risk'],
      summary: 'Create  new risk',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              name: 'Data Breach Risk',
              description: 'Risk of unauthorized access to sensitive customer data',
              category: 'Cybersecurity',
              inherent_score: 80,
              // residual_score is omitted here — it's derived from
              // inherent_score + control_design_eff/control_operating_eff
              // (aexa-server#241). Pass residual_override: true with a
              // residual_score and residual_override_reason to set it
              // manually instead.
              pagerank_score: 70,
              financial_impact_min: 50000,
              financial_impact_max: 250000,
              probability: 60,
              impact: 75,
              velocity: 'High',
              trend: 'Increasing',
              status: 'Open',
              site_id: '',
              ai_generated: false,
              is_edited: true,
              source_info: 'Internal risk assessment report',
              control_design_eff: 70,
              control_operating_eff: 60,
            }),
          },
        },
      },
      responses: {
        201: { description: 'risk created successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    get: {
      tags: ['risk'],
      summary: 'Get all risk',
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
          name: 'category',
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
        200: { description: 'risk fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },

  '/api/risk/{id}': {
    get: {
      tags: ['risk'],
      summary: 'Get single risk',
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
        200: { description: 'risk fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
    patch: {
      tags: ['risk'],
      summary: 'Update risk',
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
              name: 'Data Breach Risk',
              description: 'Risk of unauthorized access to sensitive customer data',
              category: 'Cybersecurity',
              inherent_score: 80,
              // residual_score is omitted here — it's derived from
              // inherent_score + control_design_eff/control_operating_eff
              // (aexa-server#241). Pass residual_override: true with a
              // residual_score and residual_override_reason to set it
              // manually instead.
              pagerank_score: 70,
              financial_impact_min: 50000,
              financial_impact_max: 250000,
              probability: 60,
              impact: 75,
              velocity: 'High',
              trend: 'Increasing',
              status: 'Open',
              site_id: '',
              ai_generated: false,
              is_edited: true,
              source_info: 'Internal risk assessment report',
              control_design_eff: 70,
              control_operating_eff: 60,
            }),
          },
        },
      },
      responses: {
        200: { description: 'risk updated successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
    delete: {
      tags: ['risk'],
      summary: 'Delete risk',
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
        200: { description: 'risk delete successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },
};
