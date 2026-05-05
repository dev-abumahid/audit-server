
    export const actionSwaggerDocs = {
  "/api/action": {
    post: {
      tags: ["action"],
      summary: "Create  new action",
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
        201: { description: "action created successfully" },
        500: { description: "Validation error or internal server error" },
      },
    },
    get: {
      tags: ["action"],
      summary: "Get all action",
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
        200: { description: "action fetched successfully" },
        401: { description: "unauthorized" },
      },
    },
  },

  "/api/action/{id}": {
    get: {
      tags: ["action"],
      summary: "Get single action",
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
        200: { description: "action fetched successfully" },
        401: { description: "unauthorized" },
      },
    },
    patch: {
      tags: ["action"],
      summary: "Update action",
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
        200: { description: "action updated successfully" },
        500: { description: "Validation error or internal server error" },
      },
    },
    delete: {
      tags: ["action"],
      summary: "Delete action",
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
        200: { description: "action delete successfully" },
        401: { description: "unauthorized" },
      },
    },
  },
};

    
    