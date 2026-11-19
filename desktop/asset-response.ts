import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

const mediaTypes: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

/** Stream exact byte ranges, including files inside ASAR via Electron's fs adapter.
 * net.fetch(file:) can return partial bytes with HTTP 200 and no Content-Range;
 * forwarding that response makes Chromium seek forever in exported games.
 */
export async function assetResponse(
  file: string,
  method: string,
  range: string | null,
): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD')
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Not a media file');
  const size = info.size;
  const headers = new Headers({
    'Content-Type': mediaTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range',
    'Last-Modified': info.mtime.toUTCString(),
  });
  let start = 0,
    end = size - 1;
  if (range !== null) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
    if (match && (match[1] || match[2])) {
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
    }
    if (
      !match ||
      (!match[1] && !match[2]) ||
      (!match[1] && Number(match[2]) === 0) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= size
    ) {
      headers.set('Content-Range', `bytes */${size}`);
      headers.set('Content-Length', '0');
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  headers.set('Content-Length', String(Math.max(0, end - start + 1)));
  const body =
    method === 'HEAD' || size === 0
      ? null
      : (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>);
  return new Response(body, { status: range === null ? 200 : 206, headers });
}
