export const accountSwaggerDocs = {
  '/api/auth/sign-up': {
    post: {
      tags: ['auth'],
      summary: 'Create  new account',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              email: 'user@gmail.com',
              password: 'password',
              organizationName: 'Organization Name',
            }),
          },
        },
      },
      responses: {
        201: { description: 'account created successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/auth/sign-in': {
    post: {
      tags: ['auth'],
      summary: 'Sign In your account',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              email: 'user@gmail.com',
              password: 'password',
            }),
          },
        },
      },
      responses: {
        201: { description: 'User signed in successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/auth/verify-otp': {
    put: {
      tags: ['auth'],
      summary: 'Verify OTP',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              email: 'user@gmail.com',
              otp: '654321',
            }),
          },
        },
      },
      responses: {
        201: { description: 'OTP verification successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/auth/verify-link': {
    put: {
      tags: ['auth'],
      summary: 'Verify Link',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              token: 'dsakfjasdkj',
            }),
          },
        },
      },
      responses: {
        201: { description: 'Token verification successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/auth/me': {
    get: {
      tags: ['auth'],
      summary: 'Get me account',
      description: '',
      responses: {
        200: { description: 'account fetched successfully' },
        401: { description: 'unauthorized' },
      },
    },
  },
  '/api/auth/change-password': {
    put: {
      tags: ['auth'],
      summary: 'Change Password',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              oldPassword: '123456',
              newPassword: '654321',
            }),
          },
        },
      },
      responses: {
        201: { description: 'Passwrod change successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/auth/resend-otp': {
    put: {
      tags: ['auth'],
      summary: 'Resend OTP',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              email: 'user@gmail.com',
            }),
          },
        },
      },
      responses: {
        201: { description: 'OTP resend successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/auth/forget-password': {
    put: {
      tags: ['auth'],
      summary: 'Forget Password',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              email: 'user@gmail.com',
            }),
          },
        },
      },
      responses: {
        201: { description: 'Forget password successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/auth/reset-password': {
    put: {
      tags: ['auth'],
      summary: 'Reset Password',
      description: '',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: JSON.stringify({
              token: 'dkfjadskfds',
              newPass: 'newpass',
            }),
          },
        },
      },
      responses: {
        201: { description: 'Password reset successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/auth/logout': {
    post: {
      tags: ['auth'],
      summary: 'Logout',
      description: '',
      responses: {
        200: { description: 'Logout successful.' },
        401: { description: 'unauthorized' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/auth/social/google': {
    get: {
      tags: ['social auth'],
      summary: 'Google Sign In',
      description:
        "Use this type of redirect in your front-end: <a href='/api/auth/social/google'>Google Login</a>",
      responses: {
        201: { description: 'Google Sign In successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/auth/social/facebook': {
    get: {
      tags: ['social auth'],
      summary: 'Facebook Sign In',
      description:
        "Use this type of redirect in your front-end: <a href='/api/auth/social/facebook'>Facebook Login</a>",
      responses: {
        201: { description: 'Facebook Sign In successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/auth/social/twitter': {
    get: {
      tags: ['social auth'],
      summary: 'Twitter Sign In',
      description:
        "Use this type of redirect in your front-end: <a href='/api/auth/social/twitter'>Twitter Login</a>",
      responses: {
        201: { description: 'Twitter Sign In successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/auth/social/github': {
    get: {
      tags: ['social auth'],
      summary: 'GitHub Sign In',
      description:
        "Use this type of redirect in your front-end: <a href='/api/auth/social/github'>GitHub Login</a>",
      responses: {
        201: { description: 'GitHub Sign In successfully' },
        500: { description: 'Validation error or internal server error' },
      },
    },
  },
  '/api/auth/social-providers': {
    get: {
      tags: ['social auth'],
      summary: 'Which social login providers are enabled',
      description:
        'Returns which of google/facebook/twitter/github have real OAuth credentials configured. Render only the buttons for providers that are true.',
      responses: {
        200: { description: 'Social providers fetched successfully' },
      },
    },
  },
};
