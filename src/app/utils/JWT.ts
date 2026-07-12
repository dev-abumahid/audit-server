import jwt, { JwtPayload, Secret, SignOptions } from 'jsonwebtoken';
import { configs } from '../configs/index.js';

const generateToken = (payload: object, secret: Secret, expiresIn: string) => {
  const token = jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn: expiresIn,
  } as SignOptions);

  return token;
};

const verifyToken = (token: string, secret: Secret): JwtPayload => {
  return jwt.verify(token, secret) as JwtPayload;
};

// Shared shape for every place that authenticates an account and hands back
// a session token (login, and org-invite acceptance both authenticate an
// account by one means or another and need the identical token) — one place
// to change if the access-token payload/secret/expiry ever changes.
const generateAccessToken = (account: { email: string; role: string; accountId: string }) =>
  generateToken(
    { email: account.email, role: account.role, accountId: account.accountId },
    configs.jwt.access_token as string,
    configs.jwt.access_expires as string,
  );

export const jwtHelpers = {
  generateToken,
  verifyToken,
  generateAccessToken,
};
export type JwtPayloadType = JwtPayload & {
  email: string;
  role: string;
  accountId: string;
  iat: number;
  exp: number;
};
export type JwtTokenType = string | JwtPayloadType | null;
