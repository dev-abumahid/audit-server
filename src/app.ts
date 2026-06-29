import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import session from 'express-session';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import swaggerJSDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { configs } from './app/configs/index.js';
import globalErrorHandler from './app/middlewares/global_error_handler.js';
import notFound from './app/middlewares/not_found_api.js';
import { passportConfig } from './app/passport-js/config.js';
import { redisConnection } from './app/queues/connection.js';
import manageResponse from './app/utils/manage_response.js';
import appRouter from './routes.js';
import { swaggerOptions } from './swaggerOptions.js';

if (!configs.session_secret) {
  throw new Error('SESSION_SECRET environment variable is required');
}

// define app
const app = express();

// trust nginx proxy so rate limiters key on real client IP, not proxy IP
app.set('trust proxy', 1);

// swagger docs
const swaggerSpec = swaggerJSDoc(swaggerOptions);
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// cors middleware
app.use(
  cors({
    origin: ['http://localhost:5173', 'https://globalriskcore.com'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'],
    credentials: true,
  }),
);

// express middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.raw());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// express session
app.use(
  session({
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
