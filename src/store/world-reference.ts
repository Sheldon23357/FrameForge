import { create } from 'zustand';
import { resolveProjectArtStyle } from '../../packages/domain/art-style';
import {
  attachWorldReference,
  findWorldSetting,
  worldReferenceRequest,
  type WorldReferenceKind,
  type WorldReferenceStatus,
} from '../../packages/domain/world-settings';
import { commitAgentTransaction } from '../features/agent/editor-host';
import { platform } from '../platform';
import { generateWorldReference } from '../platform/world-reference';
import { useEditor } from './editor';

interface ReferenceJob {
  id: string;
  settingId: string;
  kind: WorldReferenceKind;
  status: WorldReferenceStatus;
}

const controllers = new Map<string, AbortController>();

function waitForEditor(signal: AbortSignal) {
  signal.throwIfAborted();
  if (!useEditor.getState().playing) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      unsubscribe();
      reject(signal.reason);
    };
    const unsubscribe = useEditor.subscribe((state) => {
      if (state.playing) return;
      unsubscribe();
      signal.removeEventListener('abort', cancel);
      resolve();
    });
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export const useWorldReferences = create<{
  jobs: ReferenceJob[];
  generate(settingId: string, kind: WorldReferenceKind, versionTitle: string): Promise<void>;
  cancel(id: string): void;
}>((set, get) => ({
  jobs: [],
  cancel: (id) => controllers.get(id)?.abort(),
  generate: async (settingId, kind, versionTitle) => {
    if (get().jobs.some((job) => job.settingId === settingId && job.kind === kind)) return;
    const initial = useEditor.getState();
    const id = crypto.randomUUID();
    const controller = new AbortController();
    let unsubscribe: (() => void) | undefined;
    try {
      const original = findWorldSetting(initial.project, settingId);
      const { settings } = initial.project;
      const request = worldReferenceRequest(
        original,
        kind,
        resolveProjectArtStyle(settings),
        settings.atmosphereTone,
      );
      const requestKey = JSON.stringify(request);
      const slot = kind === 'image' ? 'imageAssetId' : 'audioAssetId';
      const job: ReferenceJob = { id, settingId, kind, status: 'queued' };
      controllers.set(id, controller);
      set(({ jobs }) => ({ jobs: [...jobs, job] }));
      const verifyTarget = (state: ReturnType<typeof useEditor.getState>) => {
        if (state.projectLoadSerial !== initial.projectLoadSerial)
          throw new DOMException('已切换工程', 'AbortError');
        const target = findWorldSetting(state.project, settingId);
        if (
          target[slot] !== original[slot] ||
          JSON.stringify(
            worldReferenceRequest(
              target,
              kind,
              resolveProjectArtStyle(state.project.settings),
              state.project.settings.atmosphereTone,
            ),
          ) !== requestKey
        )
          throw new Error('设定或画风已更改，本次参考素材生成已停止。');
      };
      unsubscribe = useEditor.subscribe((state, previous) => {
        if (state.project === previous.project) return;
        try {
          verifyTarget(state);
        } catch (error) {
          controller.abort(error);
        }
      });
      const asset = await generateWorldReference(
        initial.project.id,
        request,
        controller.signal,
        (status) =>
          set(({ jobs }) => ({
            jobs: jobs.map((entry) => (entry.id === id ? { ...entry, status } : entry)),
          })),
      );
      await waitForEditor(controller.signal);
      const latest = useEditor.getState();
      verifyTarget(latest);
      const candidate = structuredClone(latest.project);
      attachWorldReference(candidate, settingId, kind, asset);
      unsubscribe();
      if (
        !commitAgentTransaction(latest.project, candidate, [], latest.changeSerial, {
          versionTitle,
        })
      )
        throw new Error('工程已变更，无法应用这份参考素材。');
      await platform.autosave(useEditor.getState().project);
      latest.notify(`${original.name}的${kind === 'image' ? '参考图' : '音频'}已保存到工程。`);
    } catch (error) {
      const cause = controller.signal.aborted ? controller.signal.reason : error;
      if (
        useEditor.getState().projectLoadSerial === initial.projectLoadSerial &&
        !(cause instanceof DOMException && cause.name === 'AbortError')
      )
        useEditor
          .getState()
          .notify(cause instanceof Error ? cause.message : '参考素材生成失败。', 'error');
    } finally {
      unsubscribe?.();
      controllers.delete(id);
      set(({ jobs }) => ({ jobs: jobs.filter((job) => job.id !== id) }));
    }
  },
}));
