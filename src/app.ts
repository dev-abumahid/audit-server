import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Request, Response } from 'express';
import session from 'express-session';
import swaggerJSDoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import globalErrorHandler from './app/middlewares/global_error_handler.js';
import notFound from './app/middlewares/not_found_api.js';
import { passportConfig } from './app/passport-js/config.js';
import manageResponse from './app/utils/manage_response.js';
import appRouter from './routes.js';
import { swaggerOptions } from './swaggerOptions.js';

// define app
const app = express();

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
    secret: 'temp_secret_form_twitter_oauth_1.0',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
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
