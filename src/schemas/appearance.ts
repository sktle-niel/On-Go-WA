import { Type } from '@fastify/type-provider-typebox';
import { DateTime, Nullable } from './common.js';

/** PlatformAppearance in on_go_shared. */
export const PlatformAppearance = Type.Object({
  authBackgroundUrl: Nullable(Type.String()),
  updatedAt: Nullable(DateTime),
});
