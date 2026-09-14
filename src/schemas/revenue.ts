import { Type } from '@fastify/type-provider-typebox';
import { DateTime, StringEnum } from './common.js';

/** RevenueUrgency.name in on_go_shared (the Dart enum name, lower-case). */
export const RevenueUrgency = StringEnum(['normal', 'urgent', 'emergency']);

/** CompletedPaymentReport in on_go_shared. */
export const CompletedPaymentReport = Type.Object(
  {
    requestId: Type.String({ minLength: 1, maxLength: 128, description: 'The job this payment settled' }),
    platformFee: Type.Number({ minimum: 0, description: 'The priority fee booked as platform revenue, in pesos' }),
    paidAt: DateTime,
    urgency: Type.Optional(RevenueUrgency),
  },
  { additionalProperties: false },
);

export const UrgencyTotals = Type.Object({
  revenue: Type.Number(),
  transactions: Type.Integer(),
});

/** MonthlyIncome in on_go_shared. */
export const MonthlyIncome = Type.Object({
  month: Type.String({ description: 'Jan … Dec' }),
  year: Type.Integer(),
  revenue: Type.Number(),
  transactions: Type.Integer(),
  byUrgency: Type.Object({
    normal: UrgencyTotals,
    urgent: UrgencyTotals,
    emergency: UrgencyTotals,
  }),
});

/** PlatformRevenueSummary in on_go_shared. */
export const PlatformRevenueSummary = Type.Object({
  months: Type.Array(MonthlyIncome),
  priorityFeeRevenue: Type.Number(),
  priorityFeeCount: Type.Integer(),
});
