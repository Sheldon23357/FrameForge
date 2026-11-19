import { contextBridge, ipcRenderer } from 'electron';
import type { ModelStreamDelta } from '../packages/agent/types';
import { DesktopBridge } from '../src/platform/types';
const assetScope =
  process.argv.find((arg) => arg.startsWith('--frameforge-asset-scope='))?.split('=')[1] ?? '';
let modelStreamId = 0;
const bridge: DesktopBridge = {
  agent: {
    complete: async (input, onDelta) => {
      if (!onDelta) return ipcRenderer.invoke('agent:model:complete', input);
      const streamId = ++modelStreamId;
      const listener = (_event: Electron.IpcRendererEvent, id: number, delta: ModelStreamDelta) => {
        if (id === streamId) onDelta(delta);
      };
      ipcRenderer.on('agent:model:delta', listener);
      try {
        return await ipcRenderer.invoke('agent:model:complete', input, streamId);
      } finally {
        ipcRenderer.removeListener('agent:model:delta', listener);
      }
    },
    cancel: (runId) => ipcRenderer.invoke('agent:model:cancel', runId),
    listSessions: (projectId) => ipcRenderer.invoke('agent:sessions:list', projectId),
    loadCreativeDraft: (projectId) => ipcRenderer.invoke('agent:creative:load', projectId),
    saveCreativeDraft: (projectId, draft) =>
      ipcRenderer.invoke('agent:creative:save', projectId, draft),
    loadSession: (projectId, sessionId) =>
      ipcRenderer.invoke('agent:sessions:load', projectId, sessionId),
    saveSession: (session) => ipcRenderer.invoke('agent:sessions:save', session),
    deleteSession: (projectId, sessionId) =>
      ipcRenderer.invoke('agent:sessions:delete', projectId, sessionId),
  },
  agentSettings: {
    get: () => ipcRenderer.invoke('agent:settings:get'),
    save: (input) => ipcRenderer.invoke('agent:settings:save', input),
    test: (input) => ipcRenderer.invoke('agent:connection:test', input),
    cancelConnectionTest: () => ipcRenderer.invoke('agent:connection:cancel'),
    findCodexPrograms: () => ipcRenderer.invoke('agent:codex:find'),
    listCodexModels: (cliPath) => ipcRenderer.invoke('agent:codex:models', cliPath),
    chooseCodexProgram: () => ipcRenderer.invoke('agent:codex:choose'),
  },
  agentSkills: {
    refresh: () => ipcRenderer.invoke('agent:skills:refresh'),
    chooseRoot: () => ipcRenderer.invoke('agent:skills:choose-root'),
    openRoot: () => ipcRenderer.invoke('agent:skills:open-root'),
    preview: (input) => ipcRenderer.invoke('agent:skills:preview', input),
    begin: (runId) => ipcRenderer.invoke('agent:skills:begin', runId),
    read: (runId, input) => ipcRenderer.invoke('agent:skills:read', runId, input),
  },
  bootstrap: () => ipcRenderer.invoke('project:bootstrap'),
  openProject: () => ipcRenderer.invoke('project:open'),
  openProjectWindow: () => ipcRenderer.invoke('project:open-in-window'),
  saveProject: (p, saveAs) => ipcRenderer.invoke('project:save', p, saveAs),
  autosave: (p, requireWrite) => ipcRenderer.invoke('project:autosave', p, requireWrite),
  defaultProjectDirectory: (title) => ipcRenderer.invoke('project:default-directory', title),
  chooseProjectDirectory: () => ipcRenderer.invoke('project:choose-directory'),
  newProject: (p, directory) => ipcRenderer.invoke('project:new', p, directory),
  ensureVersionAssets: (p, ids) => ipcRenderer.invoke('project:version-assets', p, ids),
  importAssets: (kind, audioCategory) => ipcRenderer.invoke('media:import', kind, audioCategory),
  stageAssetImport: (projectId, audioCategory, operationId) =>
    ipcRenderer.invoke('media:stage-import', projectId, audioCategory, operationId),
  generateWorldReference: (input) => ipcRenderer.invoke('media:generate-world-reference', input),
  cancelWorldReference: (id) => ipcRenderer.invoke('media:cancel-world-reference', id),
  onWorldReferenceStatus: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      id: string,
      status: 'queued' | 'running',
    ) => callback(id, status);
    ipcRenderer.on('media:world-reference-status', listener);
    return () => ipcRenderer.removeListener('media:world-reference-status', listener);
  },
  exportGame: (p, target) => ipcRenderer.invoke('project:export', p, target),
  reveal: (p) => ipcRenderer.invoke('file:reveal', p),
  revealAsset: (projectId, assetId) => ipcRenderer.invoke('media:reveal', projectId, assetId),
  assetUrl: (id, thumbnail = false) =>
    `frameforge://asset/${encodeURIComponent(id)}?scope=${assetScope}${thumbnail ? '&thumbnail=1' : ''}`,
  onBeforeClose: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:before-close', listener);
    void ipcRenderer.invoke('app:ready', true);
    return () => {
      ipcRenderer.removeListener('app:before-close', listener);
      void ipcRenderer.invoke('app:ready', false);
    };
  },
  completeClose: (saved) => ipcRenderer.invoke('app:complete-close', saved),
};
contextBridge.exposeInMainWorld('frameforge', bridge);
