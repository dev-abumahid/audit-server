import { Router } from 'express';
import accountRouter from './app/modules/account/account.route.js';
import actionRoute from './app/modules/action/action.route.js';
import aiRoute from './app/modules/ai/ai.route.js';
import externalAuthRoute from './app/modules/external-auth/external-auth.route.js';
import inspectionRoute from './app/modules/inspection/inspection.route.js';
import noteRoute from './app/modules/note/note.route.js';
import organizationRoute from './app/modules/organization/organization.route.js';
import profileRoute from './app/modules/profile/profile.route.js';
import recommendationRoute from './app/modules/recommendation/recommendation.route.js';
import riskRoute from './app/modules/risk/risk.route.js';
import siteRoute from './app/modules/site/site.route.js';
import templateRoute from './app/modules/template/template.route.js';

const appRouter = Router();

const moduleRoutes = [
  { path: '/note', route: noteRoute },
  { path: '/recommendation', route: recommendationRoute },
  { path: '/inspection', route: inspectionRoute },
  { path: '/ai', route: aiRoute },
  { path: '/risk', route: riskRoute },
  { path: '/action', route: actionRoute },
  { path: '/site', route: siteRoute },
  { path: '/template', route: templateRoute },
  { path: '/profile', route: profileRoute },
  { path: '/organization', route: organizationRoute },
  { path: '/auth', route: accountRouter },
  { path: '/external-auth', route: externalAuthRoute },
];

moduleRoutes.forEach((route) => appRouter.use(route.path, route.route));
export default appRouter;
