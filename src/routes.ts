import { Router } from 'express';
import accountRouter from './app/modules/account/account.route.js';
import profileRoute from './app/modules/profile/profile.route.js';
import templateRoute from './app/modules/template/template.route.js';
import siteRoute from "./app/modules/site/site.route.js";
import actionRoute from "./app/modules/action/action.route";
import riskRoute from "./app/modules/risk/risk.route";

const appRouter = Router();

const moduleRoutes = [
  { path: "/risk", route: riskRoute },
  { path: "/action", route: actionRoute },
  { path: "/site", route: siteRoute },
  { path: '/template', route: templateRoute },
  { path: '/profile', route: profileRoute },
  { path: '/auth', route: accountRouter },
];

moduleRoutes.forEach((route) => appRouter.use(route.path, route.route));
export default appRouter;
