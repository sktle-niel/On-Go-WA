import { Type } from '@fastify/type-provider-typebox';
import { DateTime, Nullable, StringEnum, Uuid } from './common.js';

/** PointsPolicy in on_go_shared. */
export const PointsPolicy = Type.Object(
  {
    clientNormal: Type.Number({ minimum: 0, description: 'Points a client earns per Normal job' }),
    clientUrgent: Type.Number({ minimum: 0, description: 'Points a client earns per Urgent job' }),
    clientEmergency: Type.Number({ minimum: 0, description: 'Points a client earns per Emergency job' }),
    mechanicPerPeso: Type.Number({ minimum: 0, description: 'Points a mechanic earns per peso paid' }),
  },
  { additionalProperties: false },
);

/** PointsEntryKind.name in the mobile app. */
export const PointsEntryKind = StringEnum([
  'clientJobCompleted',
  'mechanicJobCompleted',
  'clientPaidSurcharge',
  'mechanicConvertedToBalance',
]);

/** One movement of points, in or out. */
export const PointsEntry = Type.Object({
  id: Uuid,
  kind: PointsEntryKind,
  points: Type.Number({ description: 'Signed: positive earns, negative spends' }),
  pesos: Nullable(Type.Number({ description: 'The peso side, for a conversion or a fee paid with points' })),
  note: Type.String(),
  requestId: Nullable(Uuid),
  at: DateTime,
});

/** The caller's points and, for a mechanic, what they are owed. */
export const PointsWallet = Type.Object({
  balance: Type.Number({ description: 'Points the caller can spend now: the sum of every entry' }),
  earnings: Type.Number({ description: 'Mechanic: pesos from paid jobs. 0 for a client' }),
  convertedPesos: Type.Number({ description: 'Mechanic: pesos added to the balance by converting points' }),
  availableBalance: Type.Number({ description: 'Mechanic: earnings plus convertedPesos' }),
  entries: Type.Array(PointsEntry, { description: 'Newest first, at most 200' }),
});

/** A mechanic turns points into account balance at 1 pt = ₱1. */
export const ConvertPointsBody = Type.Object(
  {
    points: Type.Number({ minimum: 1, maximum: 1_000_000, description: 'Rounded to hundredths' }),
  },
  { additionalProperties: false },
);
