import { Type } from '@fastify/type-provider-typebox';
import { Email, Nullable, Role, StringEnum, Surface, Uuid } from './common.js';

export const Password = Type.String({ minLength: 8, maxLength: 128 });

/** SignInRequest.toJson() in on_go_shared. */
export const SignInBody = Type.Object(
  {
    identifier: Type.String({ minLength: 1, maxLength: 320, description: 'The account email' }),
    password: Type.String({ minLength: 1, maxLength: 128 }),
    surface: Surface,
  },
  { additionalProperties: false },
);

/** AuthenticatedUser in on_go_shared. */
export const AuthenticatedUser = Type.Object({
  accountId: Nullable(Uuid),
  displayName: Type.String(),
  email: Type.String(),
  role: Role,
});

/** ModeratorPermissions in on_go_shared. Admins hold all four. */
export const Permissions = Type.Object(
  {
    canApprove: Type.Boolean(),
    canReject: Type.Boolean(),
    canEscalate: Type.Boolean(),
    canChangeBackground: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const AccessToken = Type.Object({
  accessToken: Type.String({ description: 'Send as `Authorization: Bearer <accessToken>`' }),
  tokenType: Type.Literal('Bearer'),
  expiresIn: Type.Integer({ description: 'Access token lifetime in seconds' }),
});

export const AuthSession = Type.Object({
  user: AuthenticatedUser,
  permissions: Permissions,
  accessToken: Type.String({ description: 'Send as `Authorization: Bearer <accessToken>`' }),
  tokenType: Type.Literal('Bearer'),
  expiresIn: Type.Integer({ description: 'Access token lifetime in seconds' }),
  refreshToken: Type.Optional(
    Type.String({
      description:
        'Mobile surface only. Store it securely (Keychain / Keystore). ' +
        'The console receives its refresh token as an httpOnly cookie instead.',
    }),
  ),
});

export const RegisterBody = Type.Object(
  {
    email: Email,
    password: Password,
    firstName: Type.String({ minLength: 1, maxLength: 100 }),
    lastName: Type.Optional(Type.String({ maxLength: 100 })),
    phone: Type.Optional(Type.String({ maxLength: 32 })),
    role: StringEnum(['client', 'mechanic'], {
      description: 'Only mobile roles self-register. Moderators are created by an admin.',
    }),
  },
  { additionalProperties: false },
);

export const ChangePasswordBody = Type.Object(
  {
    currentPassword: Type.String({ minLength: 1, maxLength: 128 }),
    newPassword: Password,
  },
  { additionalProperties: false },
);

export const ResetRequestBody = Type.Object({ email: Email }, { additionalProperties: false });

export const ResetConfirmBody = Type.Object(
  {
    email: Email,
    code: Type.String({ pattern: '^[0-9]{6}$', description: 'The six-digit code that was delivered' }),
    newPassword: Password,
  },
  { additionalProperties: false },
);

export const Accepted = Type.Object({
  status: Type.Literal('accepted'),
  message: Type.String(),
});

export const MeResponse = Type.Object({
  user: AuthenticatedUser,
  permissions: Permissions,
});
