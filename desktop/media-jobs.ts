import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assetSchema, type Asset } from '../packages/domain/schema';
import { atomicWrite } from './files';

const recordSchema = z
  .object({
    signature: z.string(),
    status: z.enum(['pending', 'completed', 'failed']),
    assets: z.array(assetSchema).optional(),
  })
  .refine((record) => record.status !== 'completed' || !!record.assets, '完成的素材作业缺少结果。');
// Shared across windows. A restarted pending job has an unknown remote outcome;
// do not silently issue a second paid generation.
const active = new Map<string, { signature: string; promise: Promise<Asset[]> }>();
export class MediaJobService {
  constructor(private directory: string) {}
  run(id: string, request: unknown, execute: () => Promise<Asset[]>): Promise<Asset[]> {
    if (!z.uuid().safeParse(id).success) return Promise.reject(new Error('素材作业 ID 无效。'));
    const file = path.join(this.directory, 'media-jobs', `${id}.json`);
    const signature = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const running = active.get(file);
    if (running)
      return running.signature === signature
        ? running.promise
        : Promise.reject(new Error('同一作业 ID 不能用于不同请求。'));
    const promise = this.perform(file, signature, execute).finally(() => active.delete(file));
    active.set(file, { signature, promise });
    return promise;
  }
  private async perform(file: string, signature: string, execute: () => Promise<Asset[]>) {
    let previous: z.infer<typeof recordSchema> | undefined;
    try {
      previous = recordSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (previous) {
      if (previous.signature !== signature)
        throw new Error('素材作业请求已改变，请明确启动新作业。');
      if (previous.status === 'completed') return previous.assets ?? [];
      throw new Error(
        '先前素材作业中断或失败，远端结果尚未确认。不会自动重复生成；核查后可明确启动新作业。',
      );
    }
    await atomicWrite(file, JSON.stringify({ signature, status: 'pending' }));
    let assets: Asset[];
    try {
      assets = z.array(assetSchema).parse(await execute());
    } catch (error) {
      await atomicWrite(file, JSON.stringify({ signature, status: 'failed' }));
      throw error;
    }
    // If this write fails, leave the pending record; never pretend a retry is safe.
    await atomicWrite(file, JSON.stringify({ signature, status: 'completed', assets }));
    return assets;
  }
}
