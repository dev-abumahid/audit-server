import { Router } from 'express';
import accountRouter from './app/modules/account/account.route.js';
import actionRoute from './app/modules/action/action.route.js';
import aiRoute from './app/modules/ai/ai.route.js';
import alertRoute from './app/modules/alert/alert.route.js';
import auditRoute from './app/modules/audit/audit.route.js';
import complianceRoute from './app/modules/compliance/compliance.route.js';
import externalAuthRoute from './app/modules/external-auth/external-auth.route.js';
import governanceRoute from './app/modules/governance/governance.route.js';
import knowledgeBaseRoute from './app/modules/knowledge_base/knowledge_base.route.js';
import kriRoute from './app/modules/kri/kri.route.js';
import inspectionRoute from './app/modules/inspection/inspection.route.js';
import intelligenceRoute from './app/modules/intelligence/intelligence.route.js';
import noteRoute from './app/modules/note/note.route.js';
import notificationRoute from './app/modules/notification/notification.route.js';
import onboardingRoute from './app/modules/onboarding/onboarding.route.js';
import organizationRoute from './app/modules/organization/organization.route.js';
import profileRoute from './app/modules/profile/profile.route.js';
import recommendationRoute from './app/modules/recommendation/recommendation.route.js';
import reportRoute from './app/modules/report/report.route.js';
import riskRoute from './app/modules/risk/risk.route.js';
import riskLinkRoute from './app/modules/risk_link/risk_link.route.js';
import siteRoute from './app/modules/site/site.route.js';
import templateRoute from './app/modules/template/template.route.js';

const appRouter = Router();

const moduleRoutes = [
  { path: '/note', route: noteRoute },
  { path: '/recommendation', route: recommendationRoute },
  { path: '/inspection', route: inspectionRoute },
  { path: '/ai', route: aiRoute },
  { path: '/risk', route: riskRoute },
  { path: '/risk-link', route: riskLinkRoute },
  { path: '/intelligence', route: intelligenceRoute },
  { path: '/kri', route: kriRoute },
  { path: '/alert', route: alertRoute },
  { path: '/audit', route: auditRoute },
  { path: '/compliance', route: complianceRoute },
  { path: '/governance', route: governanceRoute },
  { path: '/report', route: reportRoute },
  { path: '/action', route: actionRoute },
  { path: '/site', route: siteRoute },
  { path: '/template', route: templateRoute },
  { path: '/profile', route: profileRoute },
  { path: '/organization', route: organizationRoute },
  { path: '/onboarding', route: onboardingRoute },
  { path: '/auth', route: accountRouter },
  { path: '/external-auth', route: externalAuthRoute },
  { path: '/knowledge_base', route: knowledgeBaseRoute },
  { path: '/notification', route: notificationRoute },
];

moduleRoutes.forEach((route) => appRouter.use(route.path, route.route));
export default appRouter;
