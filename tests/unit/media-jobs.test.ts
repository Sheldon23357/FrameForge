import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaJobService } from '../../desktop/media-jobs';

it('persists generated results across service restart and rejects identity collisions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-media-jobs-'));
  try {
    const id = crypto.randomUUID();
    const execute = vi.fn(async () => [
      {
        id: 'asset_test',
        name: '参考图',
        path: 'assets/test.png',
        type: 'image' as const,
        size: 1,
        width: 3,
        height: 2,
        durationMs: 0,
        builtin: false,
      },
    ]);
    const first = await new MediaJobService(root).run(
      id,
      { projectId: 'one', prompt: 'a' },
      execute,
    );
    expect(
      await new MediaJobService(root).run(id, { projectId: 'one', prompt: 'a' }, execute),
    ).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      new MediaJobService(root).run(id, { projectId: 'two', prompt: 'a' }, execute),
    ).rejects.toThrow('请求已改变');
    await new MediaJobService(root).run(
      crypto.randomUUID(),
      { projectId: 'one', prompt: 'a' },
      execute,
    );
    expect(execute).toHaveBeenCalledTimes(2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('never blindly retries interrupted jobs and reuses cancellation of a file picker', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-media-jobs-'));
  try {
    const id = crypto.randomUUID();
    const execute = vi.fn(async () => {
      throw new Error('连接断开');
    });
    await expect(new MediaJobService(root).run(id, {}, execute)).rejects.toThrow('连接断开');
    await expect(new MediaJobService(root).run(id, {}, execute)).rejects.toThrow('不会自动重复');
    expect(execute).toHaveBeenCalledTimes(1);
    const picker = vi.fn(async () => []);
    const importId = crypto.randomUUID();
    await new MediaJobService(root).run(importId, { kind: 'import' }, picker);
    await new MediaJobService(root).run(importId, { kind: 'import' }, picker);
    expect(picker).toHaveBeenCalledTimes(1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
