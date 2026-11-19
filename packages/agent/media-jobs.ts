import type { ToolContext } from './types';
import type { Asset } from '../domain/schema';

export type MediaAction = 'import' | 'image' | 'audio';

export function recordedMediaAction(signature: string): MediaAction | undefined {
  try {
    const [kind, , request] = JSON.parse(signature);
    switch (kind) {
      case 'import':
        return 'import';
      case 'production-audio':
        return 'audio';
      case 'shot-image':
      case 'minimax-shot-image':
      case 'minimax-reference':
        return 'image';
      case 'generate':
        if (request?.kind === 'image') return 'image';
        if (request?.kind === 'audio') return 'audio';
    }
  } catch {
    // Malformed legacy records never grant access to an external action.
  }
}

export async function runMediaJob(
  context: ToolContext,
  action: MediaAction,
  signature: string,
  newJob: boolean,
  execute: (id: string) => Promise<Asset[]>,
): Promise<Asset[]> {
  const jobs = (context.mediaJobs ??= []);
  const existing = [...jobs]
    .reverse()
    .find(
      (job) =>
        job.signature === signature && (job.status === 'pending' || job.assets?.length === 0),
    );
  if (context.replayMediaActions?.has(action) && !existing)
    throw new Error('旧检查点只能接回已发起的素材作业。请明确要求生成或导入新素材。');
  let job = newJob ? undefined : existing;
  if (!job) {
    if (jobs.length >= 256) throw new Error('本任务素材作业已达上限，请拆分任务。');
    job = { id: crypto.randomUUID(), signature, status: 'pending' };
    jobs.push(job);
  }
  await context.saveTask?.();
  const assets = job.assets ?? (await execute(job.id));
  job.assets = assets;
  // Keep pending until the write tool binds the assets and a subsequent checkpoint
  // saves the project. Cancellation between these steps must reconnect this job.
  await context.saveTask?.();
  context.signal?.throwIfAborted();
  return assets;
}
