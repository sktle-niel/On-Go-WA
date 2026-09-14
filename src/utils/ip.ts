import type { FastifyRequest } from 'fastify';
import { hmacSha256 } from './crypto.js';

/**
 * The caller's address, as Fastify resolved it under TRUST_PROXY_HOPS. Behind
 * an ALB that is the real client; with zero trusted hops it is the socket
 * peer, so an X-Forwarded-For header a client sends itself is ignored.
 */
export function clientIp(request: FastifyRequest): string {
  return request.ip;
}

/** Pseudonymous form for the security tables — see crypto.hmacSha256. */
export function clientIpHash(request: FastifyRequest): Buffer {
  return hmacSha256(clientIp(request));
}

export function userAgentHash(request: FastifyRequest): Buffer | null {
  const header = request.headers['user-agent'];
  if (typeof header !== 'string' || header.length === 0) return null;
  return hmacSha256(header.slice(0, 512));
}
