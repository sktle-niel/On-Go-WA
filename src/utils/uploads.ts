import type { FastifyRequest } from 'fastify';
import { sniffContentType } from '../storage/storage.js';
import { AppError, badRequest } from './errors.js';

/**
 * Reads the single uploaded file from a multipart request and validates it by
 * its actual bytes, not the content-type the client claims.
 *
 * `@fastify/multipart` caps the stream at `maxBytes`; a file that hit the cap
 * comes back truncated, which we turn into 413 rather than storing a partial
 * file. Any non-file fields sent BEFORE the file part are returned too.
 */
export interface ConsumedUpload {
  body: Buffer;
  contentType: string;
  ext: string;
  fileName: string;
  fields: Record<string, string>;
}

function safeFileName(name: string | undefined, fallbackExt: string): string {
  const base = (name ?? '').replace(/^.*[\\/]/, '').trim();
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  return cleaned.length > 0 ? cleaned : `upload.${fallbackExt}`;
}

export async function consumeUpload(
  request: FastifyRequest,
  options: { maxBytes: number; allowed: readonly string[] },
): Promise<ConsumedUpload> {
  const data = await request.file({ limits: { fileSize: options.maxBytes } });
  if (!data) throw badRequest('A file upload is required.');

  const body = await data.toBuffer();
  if (data.file.truncated) {
    throw new AppError('payload_too_large', 'The file is larger than the allowed size.');
  }

  const sniffed = sniffContentType(body, options.allowed);
  if (!sniffed) {
    throw new AppError('validation_failed', `Unsupported file type. Allowed: ${options.allowed.join(', ')}.`);
  }

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(data.fields ?? {})) {
    const entry = Array.isArray(value) ? value[0] : value;
    if (entry && entry.type === 'field' && typeof entry.value === 'string') fields[key] = entry.value;
  }

  return {
    body,
    contentType: sniffed.type,
    ext: sniffed.ext,
    fileName: safeFileName(data.filename, sniffed.ext),
    fields,
  };
}
