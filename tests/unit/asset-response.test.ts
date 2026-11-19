import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assetResponse } from '../../desktop/asset-response';

it('streams full media and correct partial bodies with HTTP 206 for seek requests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-range-'));
  const file = path.join(root, '剪辑.mp4');
  const bytes = Buffer.from('0123456789abcdef');
  await fs.writeFile(file, bytes);
  for (const [range, start, end] of [
    [null, 0, 15],
    ['bytes=3-8', 3, 8],
    ['bytes=10-', 10, 15],
    ['bytes=-4', 12, 15],
    ['bytes=10-999', 10, 15],
  ] as const) {
    const r = await assetResponse(file, 'GET', range);
    expect(r.status).toBe(range ? 206 : 200);
    expect(r.headers.get('Accept-Ranges')).toBe('bytes');
    expect(r.headers.get('Content-Length')).toBe(String(end - start + 1));
    expect(r.headers.get('Content-Type')).toBe('video/mp4');
    if (range) expect(r.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/16`);
    expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes.subarray(start, end + 1));
  }
  const head = await assetResponse(file, 'HEAD', 'bytes=3-8');
  expect(head.status).toBe(206);
  expect(head.headers.get('Content-Length')).toBe('6');
  expect((await head.arrayBuffer()).byteLength).toBe(0);
  for (const range of [
    'bytes=30-',
    'bytes=4-2',
    'bytes=-0',
    'bytes=-',
    'bytes=0-1,4-5',
    'invalid',
  ]) {
    const r = await assetResponse(file, 'GET', range);
    expect(r.status).toBe(416);
    expect(r.headers.get('Content-Range')).toBe('bytes */16');
    expect((await r.arrayBuffer()).byteLength).toBe(0);
  }
  await fs.unlink(file);
  await fs.rmdir(root);
});

it('handles empty files, MIME types and unsupported methods without invalid streams', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-empty-'));
  const file = path.join(root, '环境.WAV');
  await fs.writeFile(file, '');
  const full = await assetResponse(file, 'GET', null);
  expect(full.status).toBe(200);
  expect(full.headers.get('Content-Type')).toBe('audio/wav');
  expect(full.headers.get('Content-Length')).toBe('0');
  expect((await full.arrayBuffer()).byteLength).toBe(0);
  expect((await assetResponse(file, 'GET', 'bytes=0-')).status).toBe(416);
  expect((await assetResponse(file, 'POST', null)).status).toBe(405);
  await fs.unlink(file);
  await fs.rmdir(root);
});
