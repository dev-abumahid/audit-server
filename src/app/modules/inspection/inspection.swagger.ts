
    export const inspectionSwaggerDocs = {
  "/api/inspection": {
    post: {
      tags: ["inspection"],
      summary: "Create  new inspection",
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
        201: { description: "inspection created successfully" },
        500: { description: "Validation error or internal server error" },
      },
    },
    get: {
      tags: ["inspection"],
      summary: "Get all inspection",
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
        200: { description: "inspection fetched successfully" },
        401: { description: "unauthorized" },
      },
    },
  },

  "/api/inspection/{id}": {
    get: {
      tags: ["inspection"],
      summary: "Get single inspection",
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
        200: { description: "inspection fetched successfully" },
        401: { description: "unauthorized" },
      },
    },
    patch: {
      tags: ["inspection"],
      summary: "Update inspection",
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
        200: { description: "inspection updated successfully" },
        500: { description: "Validation error or internal server error" },
      },
    },
    delete: {
      tags: ["inspection"],
      summary: "Delete inspection",
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
        200: { description: "inspection delete successfully" },
        401: { description: "unauthorized" },
      },
    },
  },
};

    
    