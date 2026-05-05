
    export const riskSwaggerDocs = {
  "/api/risk": {
    post: {
      tags: ["risk"],
      summary: "Create  new risk",
      description: "",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            example: JSON.stringify({}), // put your request body
          },
        },
      },
      responses: {
        201: { description: "risk created successfully" },
        500: { description: "Validation error or internal server error" },
      },
    },
    get: {
      tags: ["risk"],
      summary: "Get all risk",
      description: "",
      parameters: [
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "number" },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "number" },
        },
      ],
      responses: {
        200: { description: "risk fetched successfully" },
        401: { description: "unauthorized" },
      },
    },
  },

  "/api/risk/{id}": {
    get: {
      tags: ["risk"],
      summary: "Get single risk",
      description: "",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: { description: "risk fetched successfully" },
        401: { description: "unauthorized" },
      },
    },
    patch: {
      tags: ["risk"],
      summary: "Update risk",
      description: "",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            example: JSON.stringify({}), // put your request body
          },
        },
      },
      responses: {
        200: { description: "risk updated successfully" },
        500: { description: "Validation error or internal server error" },
      },
    },
    delete: {
      tags: ["risk"],
      summary: "Delete risk",
      description: "",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        200: { description: "risk delete successfully" },
        401: { description: "unauthorized" },
      },
    },
  },
};

    
    