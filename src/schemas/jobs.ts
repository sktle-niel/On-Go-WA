import { Type } from '@fastify/type-provider-typebox';
import { DateTime, Nullable, StringEnum, Uuid } from './common.js';

/**
 * The jobs domain — not in on_go_shared yet; these are the contract additions
 * the mobile app codes against once the domain moves server-side. Field names
 * mirror `HelpRequest` in `../On-Go/lib/data/quote_store.dart`.
 *
 * `urgency` keeps the capitalized values the client and the `urgency_level`
 * enum already use (Normal / Urgent / Emergency), not the lower-case revenue
 * form. Flag for the front-end dev when this lands in on_go_shared.
 */
export const Urgency = StringEnum(['Normal', 'Urgent', 'Emergency'], {
  description: 'HelpRequest.urgency — matches the urgency_level enum',
});

export const RequestStatus = StringEnum(['pending', 'matched', 'completed', 'cancelled']);

/** ServiceRequest (the wire form of HelpRequest, request-level fields only). */
export const ServiceRequest = Type.Object({
  id: Uuid,
  clientId: Uuid,
  clientName: Type.String(),
  problem: Type.String(),
  description: Type.String(),
  location: Type.String(),
  urgency: Urgency,
  /** ONGO's priority fee for this urgency, in pesos (0 / 50 / 100). */
  surcharge: Type.Integer(),
  latitude: Nullable(Type.Number()),
  longitude: Nullable(Type.Number()),
  status: RequestStatus,
  createdAt: DateTime,
  matchedAt: Nullable(DateTime),
  completedAt: Nullable(DateTime),
  mechanicId: Nullable(Uuid),
  mechanicName: Nullable(Type.String()),
  lastCancelReason: Nullable(Type.String()),
  lastCancelledBy: Nullable(Type.String()),
  lastCancelledAt: Nullable(DateTime),
  expiredAt: Nullable(DateTime),
  expiredByMechanic: Nullable(Type.String()),
});

export const CreateServiceRequestBody = Type.Object(
  {
    problem: Type.String({ minLength: 1, maxLength: 500 }),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
    location: Type.String({ minLength: 1, maxLength: 500 }),
    urgency: Urgency,
    latitude: Type.Optional(Nullable(Type.Number({ minimum: -90, maximum: 90 }))),
    longitude: Type.Optional(Nullable(Type.Number({ minimum: -180, maximum: 180 }))),
  },
  { additionalProperties: false },
);

export const CancelServiceRequestBody = Type.Object(
  {
    reason: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);

export const ListRequestsQuery = Type.Object({
  /** `open` = pending jobs (mechanics browse these); `mine` = the caller's own. */
  scope: Type.Optional(StringEnum(['open', 'mine'])),
  urgency: Type.Optional(Urgency),
});
