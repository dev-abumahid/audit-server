import { fileURLToPath } from 'node:url';
import path from 'path';
import { configs } from './app/configs/index.js';
import { accountSwaggerDocs } from './app/modules/account/account.swagger.js';
import { profileSwaggerDocs } from './app/modules/profile/profile.swagger.js';
import { templateSwaggerDocs } from './app/modules/template/template.swagger.js';
import { siteSwaggerDocs } from './app/modules/site/site.swagger.js';
import { actionSwaggerDocs } from './app/modules/action/action.swagger.js';
import { riskSwaggerDocs } from './app/modules/risk/risk.swagger.js';
import { aiSwaggerDocs } from './app/modules/ai/ai.swagger.js';
import { inspectionSwaggerDocs } from './app/modules/inspection/inspection.swagger.js';
import { recommendationSwaggerDocs } from './app/modules/recommendation/recommendation.swagger.js';
import { noteSwaggerDocs } from './app/modules/note/note.swagger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'API Doc - Build with exp-node-server',
      version: '1.0.0',
      description: 'Express + Prisma API with auto-generated Swagger docs',
    },
    paths: {
      ...accountSwaggerDocs,
      ...profileSwaggerDocs,
      ...templateSwaggerDocs,
      ...siteSwaggerDocs,
      ...actionSwaggerDocs,
      ...riskSwaggerDocs,
      ...aiSwaggerDocs,
      ...inspectionSwaggerDocs,
      ...recommendationSwaggerDocs,
      ...noteSwaggerDocs,
    },
    servers:
      configs.env === 'production'
        ? [
            { url: configs.swagger_config.production_base_url },
            { url: configs.swagger_config.development_base_url },
          ]
        : [
            { url: configs.swagger_config.development_base_url },
            { url: configs.swagger_config.production_base_url },
          ],
    components: {
      securitySchemes: {
        AuthorizationToken: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization',
          description: 'Put your accessToken here ',
        },
      },
    },
    security: [
      {
        AuthorizationToken: [],
      },
    ],
  },
  apis: [path.join(__dirname, configs.env === 'production' ? './**/*.js' : './**/*.ts')],
};
