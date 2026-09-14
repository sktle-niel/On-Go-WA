import { Type } from '@fastify/type-provider-typebox';
import { DateTime, Email, Nullable, StringEnum, Uuid } from './common.js';

/** Enums mirror `wireName` values in on_go_shared/lib/src/models/enums.dart. */
export const ApprovalStatus = StringEnum(['pending', 'approved', 'rejected']);
export const AccountRole = StringEnum(['mechanic', 'business']);
export const CredentialKind = StringEnum(['mechanic_id', 'document', 'certification']);
export const ModerationAction = StringEnum(['approved', 'rejected', 'escalated']);

/** CredentialDocument in on_go_shared. */
export const CredentialDocument = Type.Object({
  id: Uuid,
  ownerName: Type.String(),
  kind: CredentialKind,
  label: Type.String(),
  fileName: Type.String(),
  uri: Type.String({ description: 'A time-limited URL to the file' }),
  uploadedAt: DateTime,
});

/** AccountVerificationRequest in on_go_shared. */
export const AccountVerificationRequest = Type.Object({
  id: Uuid,
  userNumber: Type.String(),
  name: Type.String(),
  email: Type.String(),
  role: AccountRole,
  submittedAt: DateTime,
  documentNames: Type.Array(Type.String()),
  documents: Type.Array(CredentialDocument),
  status: ApprovalStatus,
  reason: Nullable(Type.String()),
  reviewedAt: Nullable(DateTime),
  reviewerName: Nullable(Type.String()),
  escalated: Type.Boolean(),
});

/** SubmitVerificationRequest in on_go_shared. Filed by the mechanic's own token. */
export const SubmitVerificationBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    email: Email,
    role: AccountRole,
    documentNames: Type.Optional(Type.Array(Type.String({ maxLength: 255 }), { maxItems: 50 })),
  },
  { additionalProperties: false },
);

/**
 * ModerationDecision in on_go_shared. `actorName` / `actorId` are accepted for
 * wire compatibility and IGNORED: the actor is whoever holds the token.
 */
export const ModerationDecisionBody = Type.Object(
  {
    action: ModerationAction,
    reason: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
    actorName: Type.Optional(Type.String({ maxLength: 200 })),
    actorId: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
  },
  { additionalProperties: false },
);

/** ModerationActivity in on_go_shared. */
export const ModerationActivity = Type.Object({
  id: Uuid,
  action: ModerationAction,
  requestId: Uuid,
  accountName: Type.String(),
  role: AccountRole,
  moderatorName: Type.String(),
  occurredAt: DateTime,
  reason: Nullable(Type.String()),
});

export const ListRequestsQuery = Type.Object({
  status: Type.Optional(ApprovalStatus),
  escalatedOnly: Type.Optional(Type.Boolean()),
  search: Type.Optional(Type.String({ maxLength: 100 })),
});

export const ListActivityQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});
