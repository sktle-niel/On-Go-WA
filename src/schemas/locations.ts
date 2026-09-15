import { Type } from '@fastify/type-provider-typebox';
import { DateTime, Nullable, StringEnum, Uuid } from './common.js';

/**
 * LocationApi in on_go_shared (location_api.dart, geo_location.dart). The enums
 * travel as the Dart enum NAMES (`LocationSource.name` and so on), which is how
 * LocationUpdate.toJson writes them.
 */
export const LocationSource = StringEnum(['gps', 'lastKnown', 'manual'], {
  description: 'LocationSource.name: a live fix, the device\'s last fix reused, or chosen by the user',
});
export const LocationRole = StringEnum(['client', 'mechanic'], { description: 'LocationRole.name' });
export const MechanicAvailability = StringEnum(['available', 'onJob', 'offline'], {
  description: 'MechanicAvailability.name; mechanics only',
});

/** GeoPoint: WGS84 degrees, on the planet. */
export const GeoPoint = Type.Object({
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
});

/** LocationUpdate.toJson(). The subject is the token holder, so `userId` is accepted and ignored. */
export const LocationUpdateBody = Type.Object(
  {
    point: GeoPoint,
    recordedAt: DateTime,
    accuracyMeters: Type.Optional(Nullable(Type.Number({ minimum: 0, maximum: 1_000_000 }))),
    source: LocationSource,
    userId: Type.Optional(Nullable(Type.String({ maxLength: 100, description: 'Ignored' }))),
    role: Type.Optional(Nullable(LocationRole)),
    availability: Type.Optional(Nullable(MechanicAvailability)),
  },
  { additionalProperties: false },
);

/** LocationUpdate as the server keeps it: always for a known account. */
export const LocationUpdate = Type.Object({
  point: GeoPoint,
  recordedAt: DateTime,
  accuracyMeters: Nullable(Type.Number()),
  source: LocationSource,
  userId: Uuid,
  role: LocationRole,
  availability: Nullable(MechanicAvailability),
});

export const UserIdParams = Type.Object({ userId: Uuid });

export const MechanicIdParams = Type.Object({ mechanicId: Uuid });

export const NearbyJobsQuery = Type.Object({
  radiusKm: Type.Number({
    maximum: 20_100,
    description: 'The mechanic\'s service radius in km; zero or less finds nothing',
  }),
});
