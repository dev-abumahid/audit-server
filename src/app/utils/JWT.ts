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

// Slice 5 (#55): external (non-Account) member session token. Deliberately a
// distinct `type` discriminator rather than reusing `role` — an internal
// JwtPayloadType's `role` is always one of ADMIN/USER/ORGANIZATION (checked
// by auth()'s roles.includes(...) gate), so a value here that ever collided
// with one of those would let a stolen internal token be replayed against an
// external-only route, or vice versa, if either middleware's check were ever
// loosened. Short-lived (12h) — external access is meant to be re-verified
// periodically via a fresh OTP, not a long-lived session like an internal
// account's.
const generateExternalAccessToken = (member: { externalOrgMemberId: string }) =>
  generateToken(
    { externalOrgMemberId: member.externalOrgMemberId, type: 'EXTERNAL_ORG_MEMBER' },
    configs.jwt.access_token as string,
    '12h',
  );

export const jwtHelpers = {
  generateToken,
  verifyToken,
  generateAccessToken,
  generateExternalAccessToken,
};
export type JwtPayloadType = JwtPayload & {
  email: string;
  role: string;
  accountId: string;
  iat: number;
  exp: number;
};
export type JwtTokenType = string | JwtPayloadType | null;

export type ExternalJwtPayloadType = JwtPayload & {
  externalOrgMemberId: string;
  type: 'EXTERNAL_ORG_MEMBER';
  iat: number;
  exp: number;
};
