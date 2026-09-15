import { Type, type TSchemaOptions, type TSchema, type TUnsafe } from '@fastify/type-provider-typebox';

/**
 * Building blocks shared by every route schema.
 *
 * Route schemas do two jobs at once: Fastify validates requests and
 * serializes responses against them, and @fastify/swagger turns them into the
 * OpenAPI document. One definition, both behaviours — nothing to drift.
 */

/** A string restricted to a fixed set, rendered as a plain enum in OpenAPI. */
export function StringEnum<T extends string[]>(
  values: [...T],
  options: TSchemaOptions = {},
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ type: 'string', enum: values, ...options });
}

/**
 * A value or null. Null is listed FIRST on purpose: the validator runs with
 * `coerceTypes`, and with the value schema first an incoming null is coerced to
 * fit it (null becomes 0, '' or false) before the null branch is ever tried, so
 * a booking's `latitude: null` used to be stored as 0.
 */
export const Nullable = <T extends TSchema>(schema: T) => Type.Union([Type.Null(), schema]);

export const Uuid = Type.String({ format: 'uuid' });
export const DateTime = Type.String({ format: 'date-time', description: 'ISO-8601 timestamp, UTC' });
export const Email = Type.String({ format: 'email', maxLength: 320 });

export const ROLES = ['client', 'mechanic', 'moderator', 'admin'] as const;
export const Role = StringEnum([...ROLES], { description: 'UserRole.wireName in on_go_shared' });

export const Surface = StringEnum(['mobile', 'console'], {
  description: 'AppSurface.wireName — which front end is calling',
});

export const ErrorBody = Type.Object(
  {
    error: Type.Object({
      code: Type.String({ description: 'Stable machine-readable code' }),
      message: Type.String({ description: 'Safe to show to a person' }),
      details: Type.Optional(Type.Unknown({ description: 'Field-level detail, when any' })),
      requestId: Type.Optional(Type.String({ description: 'Quote this when reporting a problem' })),
    }),
  },
  { description: 'The one error envelope every failure uses' },
);

export const NoContent = Type.Null({ description: 'No content' });

export function errorResponses(...codes: number[]): Record<number, TSchema> {
  return Object.fromEntries(codes.map((code) => [code, ErrorBody]));
}

export const IdParams = Type.Object({ id: Uuid });

export const MechanicIdParams = Type.Object({ mechanicId: Uuid });
