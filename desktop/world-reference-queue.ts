import { minimaxImageConcurrency } from '../packages/agent/settings';
import type { WorldReferenceStatus } from '../packages/domain/world-settings';

interface QueueEntry {
  start(): void;
}

/** Each lane takes waiting requests in submission order. */
export class WorldReferenceQueue {
  private readonly lanes = {
    audio: { running: 0, limit: 1, waiting: [] as QueueEntry[] },
    image: { running: 0, limit: 1, waiting: [] as QueueEntry[] },
    minimax: { running: 0, limit: minimaxImageConcurrency, waiting: [] as QueueEntry[] },
  };

  run<T>(
    kind: keyof WorldReferenceQueue['lanes'],
    signal: AbortSignal,
    status: (value: WorldReferenceStatus) => void,
    work: () => Promise<T>,
  ): Promise<T> {
    const lane = this.lanes[kind];
    return new Promise<T>((resolve, reject) => {
      signal.throwIfAborted();
      const cancel = () => {
        const index = lane.waiting.indexOf(entry);
        if (index < 0) return;
        lane.waiting.splice(index, 1);
        reject(signal.reason);
      };
      const entry: QueueEntry = {
        start: () => {
          lane.running++;
          signal.removeEventListener('abort', cancel);
          void Promise.resolve()
            .then(() => {
              signal.throwIfAborted();
              status('running');
              return work();
            })
            .then(resolve, reject)
            .finally(() => {
              lane.running--;
              lane.waiting.shift()?.start();
            });
        },
      };
      if (lane.running < lane.limit) entry.start();
      else {
        lane.waiting.push(entry);
        signal.addEventListener('abort', cancel, { once: true });
        status('queued');
      }
    });
  }
}
