import { Type } from '@fastify/type-provider-typebox';

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
