import { Response } from 'express';
import { configs } from '../configs/index.js';
import { jwtHelpers } from '../utils/JWT.js';
import manageResponse from '../utils/manage_response.js';

// Only ever called from the 4 OAuth provider callback routes
// (account.route.ts), never from a plain API request a JS client reads the
// body of -- the browser lands here via a full-page redirect through the
// provider's own consent screen, so this response IS what the user's
// browser tab shows next. It used to just return raw JSON, which meant the
// browser was left sitting on api.<domain>/api/auth/social/.../callback
// showing a JSON blob instead of ever landing back in the app (found live
// while testing the qiyrix.com cutover -- would have behaved identically on
// the old globalriskcore.com setup too, just never exercised end-to-end
// before). The access_token cookie set below is what the SPA's own
// useGetMeQuery bootstrap check actually relies on; redirecting without
// putting the token in the URL avoids leaking it into browser history,
// Referer headers, or server access logs.
export const customAccessTokenAndResponse = (req: any, res: Response) => {
  // make access token
  const accessToken = jwtHelpers.generateToken(
    {
      accountId: req?.user?.id as string,
      email: req?.user?.email as string,
      role: req?.user?.role as string,
    },
    configs.jwt.access_token as string,
    configs.jwt.access_expires as string,
  );

  // set token into cookie
  res.cookie('access_token', accessToken, {
    secure: configs.env === 'production',
    httpOnly: true,
  });

  if (configs.jwt.front_end_url) {
    res.redirect(configs.jwt.front_end_url);
    return;
  }

  // No FRONT_END_URL configured (e.g. an environment that never set it) --
  // fall back to the original JSON response rather than redirecting to
  // "undefined" and breaking the flow outright.
  manageResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Login successfully',
    data: {
      accessToken,
    },
  });
};
