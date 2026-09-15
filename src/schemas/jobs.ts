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
  // Progress on a matched job (slice 4).
  navigating: Type.Boolean(),
  navigatingAt: Nullable(DateTime),
  enRoute: Type.Boolean(),
  enRouteAt: Nullable(DateTime),
  arrived: Type.Boolean(),
  arrivedAt: Nullable(DateTime),
  workStarted: Type.Boolean(),
  workStartedAt: Nullable(DateTime),
  serviceCompleted: Type.Boolean(),
  serviceCompletedAt: Nullable(DateTime),
  lastCancelReason: Nullable(Type.String()),
  lastCancelledBy: Nullable(Type.String()),
  lastCancelledAt: Nullable(DateTime),
  expiredAt: Nullable(DateTime),
  expiredByMechanic: Nullable(Type.String()),
  // Payment (slice 5): null until the job is paid, except the agreed amount.
  /** EMERGENCY ONLY: the price the mechanic and client agreed in person, in pesos. */
  agreedPaymentAmount: Nullable(Type.Number()),
  agreedPaymentAmountSetAt: Nullable(DateTime),
  paymentCompleted: Type.Boolean(),
  paymentCompletedAt: Nullable(DateTime),
  /** The mechanic's amount as charged, in pesos. */
  amountPaid: Nullable(Type.Number()),
  /** ONGO's priority fee as booked at payment, in pesos (0 on a Normal job). */
  platformFeeCharged: Nullable(Type.Number()),
  /** Points the client spent on the fee (1 pt = ₱1); null when the fee was paid in pesos. */
  feePaidWithPoints: Nullable(Type.Number()),
  /** Points the mechanic earned on this job. */
  pointsAwarded: Nullable(Type.Number()),
  /** Points the client earned on this job. */
  clientPointsAwarded: Nullable(Type.Number()),
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

/** MechanicQuote (the wire form). Emergency jobs are accepted directly, not
 *  quoted, so quotes are only for Normal / Urgent requests. */
export const MechanicQuote = Type.Object({
  id: Uuid,
  requestId: Uuid,
  mechanicId: Uuid,
  mechanicName: Type.String(),
  /** The mechanic's price for the job, in pesos. */
  price: Type.Number(),
  /** Promised time to REACH the client, in minutes; the client counts down against it. */
  etaMinutes: Type.Integer(),
  rating: Type.Number(),
  accepted: Type.Boolean(),
  withdrawnAt: Nullable(DateTime),
  rejectedAt: Nullable(DateTime),
  createdAt: DateTime,
});

export const SubmitQuoteBody = Type.Object(
  {
    price: Type.Number({ minimum: 0 }),
    etaMinutes: Type.Integer({ minimum: 1, maximum: 60 * 24 * 14 }),
  },
  { additionalProperties: false },
);

/** A mechanic accepts an Emergency directly; the price is agreed in person. */
export const AcceptEmergencyBody = Type.Object(
  {
    etaMinutes: Type.Integer({ minimum: 1, maximum: 12 * 60 }),
  },
  { additionalProperties: false },
);

/** EMERGENCY ONLY: the assigned mechanic records the price agreed in person. */
export const AgreedAmountBody = Type.Object(
  {
    amount: Type.Number({ minimum: 0.01, maximum: 1_000_000, description: 'Pesos, rounded to centavos' }),
  },
  { additionalProperties: false },
);

/** The client pays for a finished job. Every figure is settled by the server. */
export const PayBody = Type.Object(
  {
    payFeeWithPoints: Type.Optional(
      Type.Boolean({ description: 'Spend points on the priority fee when the balance covers it' }),
    ),
    expectedAmount: Type.Optional(
      Type.Number({ minimum: 0, description: 'The mechanic amount the client saw; a different current amount is 409' }),
    ),
  },
  { additionalProperties: false },
);
