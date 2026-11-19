import {
  sessionSchema,
  type AgentAPI,
  type AgentSession,
  type ModelClient,
} from '../../packages/agent/types';
import { creativeDraftSchema } from '../../packages/agent/creative-state';

async function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('frameforge-agent', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('sessions', { keyPath: 'id' });
      store.createIndex('projectId', 'projectId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('sessions', mode);
    const request = action(tx.objectStore('sessions'));
    tx.oncomplete = () => {
      database.close();
      resolve(request.result);
    };
    tx.onerror = () => {
      database.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      database.close();
      reject(tx.error ?? new Error('对话保存已中断。'));
    };
  });
}
const browser: AgentAPI = {
  complete: async () => {
    throw new Error('创作 Agent 的模型调用请使用桌面版；浏览器可查看和管理对话。');
  },
  cancel: async () => {},
  listSessions: async (projectId) => {
    const rows = (await transaction('readonly', (s) =>
      s.index('projectId').getAll(projectId),
    )) as AgentSession[];
    return rows
      .map(({ id, projectId, title, createdAt, updatedAt }) => ({
        id,
        projectId,
        title,
        createdAt,
        updatedAt,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  loadSession: async (projectId, sessionId) => {
    const raw = await transaction('readonly', (s) => s.get(sessionId));
    if (!raw) return null;
    const value = sessionSchema.parse(raw);
    if (value.projectId !== projectId) throw new Error('对话不属于当前工程。');
    return value;
  },
  saveSession: async (value) => {
    await transaction('readwrite', (s) => s.put(sessionSchema.parse(value)));
  },
  deleteSession: async (projectId, sessionId) => {
    const value = await browser.loadSession(projectId, sessionId);
    if (value) await transaction('readwrite', (s) => s.delete(sessionId));
  },
  loadCreativeDraft: async (projectId) => {
    const raw = localStorage.getItem('frameforge-creative:' + projectId);
    return raw ? creativeDraftSchema.parse(JSON.parse(raw)) : null;
  },
  saveCreativeDraft: async (projectId, draft) => {
    localStorage.setItem(
      'frameforge-creative:' + projectId,
      JSON.stringify(creativeDraftSchema.parse(draft)),
    );
  },
};
export const agentAPI: AgentAPI = window.frameforge?.agent ?? browser;
export const requestModel: ModelClient = (input, signal, onDelta) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('已停止', 'AbortError'));
      return;
    }
    const stop = () => {
      void agentAPI.cancel(input.runId).catch(() => {});
      reject(new DOMException('已停止', 'AbortError'));
    };
    signal.addEventListener('abort', stop, { once: true });
    agentAPI
      .complete(
        input,
        onDelta &&
          ((delta) => {
            if (!signal.aborted) onDelta(delta);
          }),
      )
      .then(resolve, (error) =>
        reject(
          new Error(
            error instanceof Error
              ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
              : '模型请求失败。',
          ),
        ),
      )
      .finally(() => signal.removeEventListener('abort', stop));
  });
