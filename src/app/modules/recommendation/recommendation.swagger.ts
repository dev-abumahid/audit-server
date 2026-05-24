
export const recommendationSwaggerDocs = {
  "/api/recommendation/inspection/{inspectionId}": {
    get: {
      tags: ["recommendation"],
      summary: "Get recommendation by inspectionId",
      description: "",
      parameters: [
        {
          name: "inspectionId",
          in: "path",
          required: true,
          schema: { type: "string" },
        }
      ],
      responses: {
        200: { description: "recommendation fetched successfully" },
        401: { description: "unauthorized" },
      },
    },
  },
  "/api/recommendation": {
    get: {
      tags: ["recommendation"],
      summary: "Get all recommendation",
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
        200: { description: "recommendation fetched successfully" },
        401: { description: "unauthorized" },
      },
    },
  },

  "/api/recommendation/{id}": {
    get: {
      tags: ["recommendation"],
      summary: "Get single recommendation",
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
        200: { description: "recommendation fetched successfully" },
        401: { description: "unauthorized" },
      },
    },
    patch: {
      tags: ["recommendation"],
      summary: "Update recommendation",
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
        200: { description: "recommendation updated successfully" },
        500: { description: "Validation error or internal server error" },
      },
    },
    delete: {
      tags: ["recommendation"],
      summary: "Delete recommendation",
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
        200: { description: "recommendation delete successfully" },
        401: { description: "unauthorized" },
      },
    },
  },
  "/api/recommendation/update-question/{recQuestionId}": {
    patch: {
      tags: ["recommendation"],
      summary: "Update recommendation",
      description: "",
      parameters: [
        {
          name: "recQuestionId",
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
        200: { description: "recommendation updated successfully" },
        500: { description: "Validation error or internal server error" },
      },
    }
  },
};


