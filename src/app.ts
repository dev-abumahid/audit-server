import connectRedis from 'connect-redis';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import session from 'express-session';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import swaggerJSDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { configs } from './app/configs/index.js';
import globalErrorHandler from './app/middlewares/global_error_handler.js';
import notFound from './app/middlewares/not_found_api.js';
import { passportConfig } from './app/passport-js/config.js';
import { redisConnection } from './app/queues/connection.js';
import { isDocsRouteEnabled } from './app/utils/docs_visibility.js';
import manageResponse from './app/utils/manage_response.js';
import { uploadCleanupSafetyNet } from './app/utils/upload_cleanup.js';
import appRouter from './routes.js';
import { swaggerOptions } from './swaggerOptions.js';

if (!configs.session_secret) {
  throw new Error('SESSION_SECRET environment variable is required');
}

if (!configs.ai_internal_secret) {
  throw new Error('AI_INTERNAL_SECRET environment variable is required');
}

// configs.port is Number(process.env.PORT); an unset or non-numeric PORT
// yields NaN, and app.listen(NaN, ...) silently binds an OS-assigned random
// port instead of failing — a confusing, hard-to-diagnose boot state. Fail
// fast here, mirroring the SESSION_SECRET/AI_INTERNAL_SECRET checks above.
if (!Number.isInteger(configs.port) || configs.port <= 0 || configs.port > 65535) {
  throw new Error('PORT environment variable is required and must be a valid port (1-65535)');
}

// define app
const app = express();

// trust nginx proxy so rate limiters key on real client IP, not proxy IP
app.set('trust proxy', 1);

// swagger docs — not mounted in production: publishes the full API attack
// map (every route, shape, auth requirement) to anyone with no auth at all.
// Confirmed live at api.globalriskcore.com/docs before this fix. Still
// available in dev/staging for the team. No basic-auth/internal-only-guard
// pattern exists anywhere else in this codebase to reuse, and building one
// just for this single endpoint would be more surface than the problem
// needs — disabling outright in production is simpler and at least as safe.
// (#38)
if (isDocsRouteEnabled(configs.env)) {
  const swaggerSpec = swaggerJSDoc(swaggerOptions);
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

// cors middleware
app.use(
  cors({
    origin: ['http://localhost:5173', 'https://globalriskcore.com'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'],
    credentials: true,
  }),
);

// express middleware
// 5mb is generous for this API: every JSON body is structured text (template
// pages/questions, inspection question-answers, AI risk-analysis results),
// never embedded file data — uploads go through multer/S3 (see uploader.ts)
// and never hit this body parser. The largest legitimate payload traced
// (a template with hundreds of pages/questions, or an inspection with many
// question answers) is well under 1mb; 5mb leaves headroom without
// re-opening the DoS-via-oversized-body surface a 100mb limit allows.
// See #114.
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// helmet: standard Express security-headers middleware (X-Content-Type-Options,
// X-Frame-Options, Strict-Transport-Security, etc.), default config. Placed
// after the /docs mount above (swagger UI serves real HTML with an inline
// bootstrap script — default helmet CSP would break it) so /docs keeps
// rendering unaffected; every other route in this API-only, JSON-only
// backend gets the defaults with no conflicting response shape to worry
// about. Flagged as a minor gap in the same audit pass as issue #275.
app.use(helmet());

// express session — Redis-backed, not the express-session default
// (in-memory MemoryStore, which leaks memory and doesn't survive past one
// process). Reuses the same ioredis connection already established for rate
// limiting below (redisConnection) rather than opening a second connection.
//
// Pinned to connect-redis@6 (see src/app/types/connect-redis.d.ts for why):
// its RedisStore talks to the client with array/callback-style calls that
// are wire-compatible with ioredis. connect-redis@7+ switched to the
// node-redis v4 client API (options-object `set()`, `scanIterator`), which
// is not compatible with ioredis and would silently fail session writes.
const SessionRedisStore = connectRedis(session);
app.use(
  session({
    store: new SessionRedisStore({ client: redisConnection, prefix: 'sess:' }),
    secret: configs.session_secret as string,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: configs.env === 'production',
      maxAge: 1000 * 60 * 10,
    },
  }),
);

// passport js
app.use(passportConfig.initialize());
app.use(passportConfig.session());

passportConfig.serializeUser((user: any, done) => {
  done(null, user);
});
passportConfig.deserializeUser((obj: any, done) => {
  done(null, obj);
});

// rate limiting
const makeRedisStore = (prefix: string) =>
  new RedisStore({
    prefix,
    sendCommand: (command: string, ...args: string[]) =>
      redisConnection.call(command, ...args) as Promise<RedisReply>,
  });

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:api:'),
});

app.use('/api', apiLimiter);

// Safety net for uploader.ts's local-disk temp files (aexa-server#305, and
// the client-abort gap in that closed by #309) — see uploadCleanupSafetyNet's
// own doc comment in upload_cleanup.ts for what it covers and why it listens
// for both 'finish' and 'close'.
app.use(uploadCleanupSafetyNet);

// Main router
app.use('/api', appRouter);

// stating point
app.get('/', (req: Request, res: Response) => {
  manageResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Server is running successful !!',
    data: null,
  });
});

// global error handler
app.use(globalErrorHandler);
app.use(notFound);

// export app
export default app;
