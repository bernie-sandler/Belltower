// Streams an uploaded file part to a temp file, measuring it and keeping its first bytes for type
// detection. Used by card attachments and the submit page's screenshots.

import type { MultipartFile } from '@fastify/multipart';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../errors';
import type { UploadedFile } from '../services/attachments';

const HEAD_BYTES = 8192;

export const tooLarge = (maxBytes: number) =>
  new AppError(413, 'too_large', `Files can be at most ${Math.round(maxBytes / 1024 / 1024)} MB (MAX_UPLOAD_MB)`);

/** Writes the part to `tmpDir`; adds the temp path to `tmpPaths` first so callers can always clean up. */
export async function saveUploadPart(part: MultipartFile, tmpDir: string, maxBytes: number, tmpPaths: string[]): Promise<UploadedFile> {
  const tmpPath = path.join(tmpDir, `${randomUUID()}.part`);
  tmpPaths.push(tmpPath);
  const hash = createHash('sha256');
  let size = 0;
  const head: Buffer[] = [];
  let headLen = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      if (headLen < HEAD_BYTES) {
        const take = chunk.subarray(0, HEAD_BYTES - headLen);
        head.push(take);
        headLen += take.length;
      }
      cb(null, chunk);
    },
  });
  await pipeline(part.file, meter, createWriteStream(tmpPath));
  if (part.file.truncated) throw tooLarge(maxBytes);
  return { tmpPath, originalName: part.filename, sizeBytes: size, sha256: hash.digest('hex'), head: Buffer.concat(head) };
}
