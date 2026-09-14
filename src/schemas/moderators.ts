import { Type } from '@fastify/type-provider-typebox';
import { Password, Permissions } from './auth.js';
import { DateTime, Email, Nullable, StringEnum, Uuid } from './common.js';

export const ModeratorStatus = StringEnum(['active', 'inactive']);
export const AuditAction = StringEnum([
  'added',
  'removed',
  'promoted',
  'approved',
  'rejected',
  'escalated',
]);

/** ModeratorAccount in on_go_shared. */
export const ModeratorAccount = Type.Object({
  id: Uuid,
  name: Type.String(),
  email: Type.String(),
  role: Type.String({ description: 'Display role, e.g. "Moderator"' }),
  status: ModeratorStatus,
  addedAt: DateTime,
  actionsHandled: Type.Integer(),
  permissions: Permissions,
  photoUrl: Nullable(Type.String()),
});

/** CreateModeratorRequest in on_go_shared. */
export const CreateModeratorBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    email: Email,
    temporaryPassword: Password,
    role: Type.Optional(Type.String({ maxLength: 50, default: 'Moderator' })),
    permissions: Type.Optional(Permissions),
  },
  { additionalProperties: false },
);

export const UpdateProfileBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    photoUrl: Type.Optional(Nullable(Type.String({ maxLength: 2048 }))),
  },
  { additionalProperties: false },
);

export const RemoveModeratorQuery = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 1000 })),
});

/** AuditEntry in on_go_shared. */
export const AuditEntry = Type.Object({
  id: Uuid,
  moderatorName: Type.String({ description: 'The account the action was about' }),
  action: AuditAction,
  role: Type.String(),
  actorName: Type.String(),
  actorRole: Type.String(),
  ipAddress: Nullable(Type.String()),
  occurredAt: DateTime,
  reason: Nullable(Type.String()),
});
