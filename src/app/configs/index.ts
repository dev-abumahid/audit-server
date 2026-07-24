import 'dotenv/config';

export const configs = {
  port: Number(process.env.PORT),
  env: process.env.NODE_ENV,
  db_url: process.env.DATABASE_URL,
  jwt: {
    access_token: process.env.ACCESS_TOKEN,
    refresh_token: process.env.REFRESH_TOKEN,
    access_expires: process.env.ACCESS_EXPIRES,
    refresh_expires: process.env.REFRESH_EXPIRES,
    reset_secret: process.env.RESET_SECRET,
    reset_expires: process.env.RESET_EXPIRES,
    front_end_url: process.env.FRONT_END_URL,
    verified_token: process.env.VERIFIED_TOKEN,
  },
  email: {
    app_email: process.env.APP_USER_EMAIL,
    app_password: process.env.APP_PASSWORD,
  },
  aws: {
    bucket: process.env.AWS_BUCKET,
    region: process.env.AWS_REGION,
    access_key_id: process.env.AWS_ACCESS_KEY_ID,
    secret_access_key: process.env.AWS_SECRET_ACCESS_KEY,
  },
  swagger_config: {
    development_base_url: process.env.DEVELOPMENT_BASE_URL,
    production_base_url: process.env.PRODUCTION_BASE_URL,
  },
  redis_config: {
    hosted_redis_connection: process.env.HOSTED_REDIS_CONNECTION,
    hosted_redis_db_url: process.env.HOSTED_REDIS_DB_URL,
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
  },
  google_login_config: {
    is_google_login: process.env.IS_GOOGLE_LOGIN === 'true',
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    callback_url: process.env.GOOGLE_CALLBACK_URL,
  },
  facebook_login_config: {
    is_facebook_login: process.env.IS_FACEBOOK_LOGIN === 'true',
    app_id: process.env.FACEBOOK_APP_ID,
    app_secret: process.env.FACEBOOK_APP_SECRET,
    callback_url: process.env.FACEBOOK_CALLBACK_URL,
  },
  twitter: {
    is_twitter_login: process.env.IS_TWITTER_LOGIN === 'true',
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    callback_url: process.env.TWITTER_CALLBACK_URL,
  },
  github: {
    is_github_login: process.env.IS_GITHUB_LOGIN === 'true',
    client_id: process.env.GITHUB_CLIENT_ID,
    client_secret: process.env.GITHUB_CLIENT_SECRET,
    callback_url: process.env.GITHUB_CALLBACK_URL,
  },
  ai_server_end_point: process.env.AI_SERVER_ENDPOINT as string,
  ai_internal_secret: process.env.AI_INTERNAL_SECRET as string,
  // Path to a system Chromium for Puppeteer's PDF rendering. Unset in local
  // dev (Puppeteer uses its own bundled Chromium); set in the production
  // Docker image to /usr/bin/chromium since the bundled Chromium can't run on
  // Alpine musl. See Dockerfile.
  puppeteer_executable_path: process.env.PUPPETEER_EXECUTABLE_PATH,
  session_secret: process.env.SESSION_SECRET,
};
