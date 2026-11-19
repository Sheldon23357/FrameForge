import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nativeImage } from 'electron';
import { atomicWrite, exists } from './files';

const maxWidth = 320;
const maxHeight = 180;
const pending = new Map<string, Promise<string>>();
let generationQueue = Promise.resolve();

export async function imageThumbnail(source: string, directory: string): Promise<string> {
  const { size, mtimeMs } = await fs.stat(source);
  const key = createHash('sha256')
    .update(JSON.stringify([source, size, mtimeMs]))
    .digest('hex');
  const target = path.join(directory, key + '.png');
  const existing = pending.get(target);
  if (existing) return existing;

  const job = generationQueue.then(async () => {
    if (await exists(target)) return target;
    const image = nativeImage.createFromBuffer(await fs.readFile(source));
    if (image.isEmpty()) return source;
    const { width, height } = image.getSize();
    const scale = Math.min(maxWidth / width, maxHeight / height);
    if (scale >= 1) return source;
    const resized = image.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'better',
    });
    await atomicWrite(target, resized.toPNG());
    return target;
  });
  generationQueue = job.then(() => {}, () => {});
  pending.set(target, job);
  try {
    return await job;
  } finally {
    pending.delete(target);
  }
}
