import { safePath } from './files';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  safeStorage,
  screen,
  shell,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assetResponse } from './asset-response';
import { ProjectService } from './project-service';
import { AgentSettingsService } from './agent-settings';
import { MediaJobService } from './media-jobs';
import { WorldReferenceService } from './world-reference';
import { WorldReferenceQueue } from './world-reference-queue';
import { AgentModelService } from './agent-model';
import { AgentSessionService } from './agent-sessions';
import { AgentSkillRuns, AgentSkillService } from './agent-skills';
import { editorWorkspaceDirectory } from './editor-paths';
import type { BootResult } from '../src/platform/types';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'frameforge',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
const appRoot = app.getAppPath();
const standalone = existsSync(path.join(appRoot, 'game', 'project.json'));
const workspace = standalone ? undefined : editorWorkspaceDirectory();
const dataOverride = process.env.FRAMEFORGE_USER_DATA;
const appData = dataOverride
  ? path.resolve(dataOverride)
  : workspace && path.join(workspace, '.local', 'frameforge');
if (appData) {
  // Chromium opens its profile on ready. The single-instance lock also uses userData.
  mkdirSync(appData, { recursive: true });
  app.setPath('userData', appData);
  app.setPath('sessionData', appData);
}
const rendererRoot = path.join(appRoot, 'dist');
const projectWindows = new Map<BrowserWindow, ProjectService>();
const assetScopes = new Map<string, ProjectService>();
const rendererHandlers = new Map<number, Map<string, (...args: any[]) => unknown>>();
const registered = new Set<string>();
const reservedFiles = new Map<string, ProjectService>();
let recentEditor: BrowserWindow | undefined;
let projectOpening: Promise<unknown> = Promise.resolve();

const fileKey = (file: string) =>
  process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

function findOpenFile(file: string, except: ProjectService) {
  const key = fileKey(file);
  return [...projectWindows].find(
    ([, project]) => project !== except && project.filePath && fileKey(project.filePath) === key,
  )?.[0];
}

async function reserveFile(file: string, owner: ProjectService) {
  const canonical = await fs
    .realpath(file)
    .catch(async () =>
      path.join(
        await fs.realpath(path.dirname(file)).catch(() => path.dirname(file)),
        path.basename(file),
      ),
    );
  const key = fileKey(canonical);
  if (reservedFiles.has(key) || findOpenFile(canonical, owner))
    throw new Error('该工程文件正在另一个操作或窗口中使用。');
  reservedFiles.set(key, owner);
  return () => reservedFiles.delete(key);
}

function openProject(
  owner: BrowserWindow,
  target: ProjectService,
  inNewWindow: boolean,
  beforeReplace: () => void,
) {
  return target.chooseFile(owner).then((file) => {
    if (!file) return null;
    const opening = projectOpening
      .catch(() => {})
      .then(async () => {
        if (owner.isDestroyed()) return null;
        const found =
          findOpenFile(file, target) ??
          (inNewWindow && target.filePath && fileKey(target.filePath) === fileKey(file)
            ? owner
            : undefined);
        if (found) {
          found.focus();
          return null;
        }
        const loaded = await ProjectService.readFile(file);
        if (owner.isDestroyed()) return null;
        const duplicate = [...projectWindows].find(
          ([, project]) =>
            (inNewWindow || project !== target) && project.project.id === loaded.project.id,
        )?.[0];
        if (duplicate) {
          duplicate.focus();
          return null;
        }
        const release = await reserveFile(file, target);
        try {
          if (!inNewWindow) {
            beforeReplace();
            return await target.openFile(file, loaded);
          }
          let window: BrowserWindow | undefined;
          const service = new ProjectService(
            rendererRoot,
            __dirname,
            () => !!window && recentEditor === window,
          );
          const boot = await service.openFile(file, loaded);
          window = await createWindow(service, boot);
          return null;
        } finally {
          release();
        }
      });
    projectOpening = opening;
    return opening;
  });
}

function registerAssetProtocol() {
  protocol.handle('frameforge', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'asset') return new Response('Forbidden', { status: 403 });
      const service = assetScopes.get(url.searchParams.get('scope') ?? '');
      if (!service) return new Response('Asset not found', { status: 404 });
      const file = await service.asset(
        decodeURIComponent(url.pathname.slice(1)),
        url.searchParams.has('thumbnail'),
      );
      const source = await assetResponse(file, request.method, request.headers.get('range'));
      // Local frame sampling and waveform decoding use the same constrained asset route.
      // Only the packaged file renderer and the configured development renderer may read it.
      const origin = request.headers.get('origin') ?? 'null';
      const developmentOrigin = process.env.VITE_DEV_SERVER_URL
        ? new URL(process.env.VITE_DEV_SERVER_URL).origin
        : undefined;
      const headers = new Headers(source.headers);
      if (origin === 'null' || origin === developmentOrigin) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Vary', 'Origin');
      }
      return new Response(source.body, {
        status: source.status,
        statusText: source.statusText,
        headers,
      });
    } catch {
      return new Response('Asset not found', { status: 404 });
    }
  });
}

let agentSettings: AgentSettingsService;
let agentSkills: AgentSkillService;
let agentSessions: AgentSessionService;
const referenceQueue = new WorldReferenceQueue();

async function createWindow(service: ProjectService, boot: BootResult) {
  const scope = randomUUID();
  const isPlayer = service.mode === 'player';
  const { width: gameWidth, height: gameHeight } = boot.project.settings;
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const scale = Math.min(
    1,
    (workArea.width * 0.9) / gameWidth,
    (workArea.height * 0.85) / gameHeight,
  );
  const playerWidth = Math.round(gameWidth * scale);
  const playerHeight = Math.round(gameHeight * scale);
  const win = new BrowserWindow({
    width: isPlayer ? playerWidth : 1600,
    height: isPlayer ? playerHeight : 1000,
    minWidth: isPlayer ? 0 : 1100,
    minHeight: isPlayer ? 0 : 720,
    useContentSize: isPlayer,
    maximizable: !isPlayer,
    backgroundColor: '#141414',
    icon: path.join(service.rendererRoot, 'app-icon.png'),
    title: service.mode === 'player' ? boot.project.title : '帧叙',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--frameforge-asset-scope=${scope}`],
    },
  });
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const senderId = win.webContents.id;
  rendererHandlers.set(senderId, handlers);
  assetScopes.set(scope, service);
  projectWindows.set(win, service);
  if (!isPlayer) {
    recentEditor ??= win;
    win.on('focus', () => {
      recentEditor = win;
    });
  }
  if (isPlayer) {
    const ratio = gameWidth / gameHeight;
    const [outerWidth, outerHeight] = win.getSize();
    const [contentWidth, contentHeight] = win.getContentSize();
    const frameWidth = outerWidth - contentWidth;
    const frameHeight = outerHeight - contentHeight;
    const minimumScale = Math.min(scale, 320 / Math.min(gameWidth, gameHeight));
    win.setMinimumSize(
      Math.round(gameWidth * minimumScale) + frameWidth,
      Math.round(gameHeight * minimumScale) + frameHeight,
    );
    // On Windows, constrain the content explicitly: native aspect locking can
    // constrain the outer frame instead, especially with display scaling.
    if (process.platform === 'win32') {
      win.on('will-resize', (event, bounds, { edge }) => {
        if (win.isFullScreen()) return;
        event.preventDefault();
        const current = win.getBounds();
        const [width, height] = win.getContentSize();
        const borderWidth = current.width - width;
        const borderHeight = current.height - height;
        const requestedWidth = ['top', 'bottom'].includes(edge)
          ? (bounds.height - borderHeight) * ratio
          : bounds.width - borderWidth;
        const nextWidth = Math.max(gameWidth * minimumScale, requestedWidth);
        const next = {
          ...bounds,
          width: Math.round(nextWidth) + borderWidth,
          height: Math.round(nextWidth / ratio) + borderHeight,
        };
        if (edge.includes('left')) next.x = current.x + current.width - next.width;
        if (edge.includes('top')) next.y = current.y + current.height - next.height;
        win.setBounds(next);
      });
    } else win.setAspectRatio(ratio);
    win.setContentSize(playerWidth, playerHeight);
    win.center();
  }
  let allowClose = false;
  let closePending = false;
  let editorReady = false;
  const handle = (name: string, fn: (...args: any[]) => unknown, editorOnly = false) => {
    handlers.set(name, (...args) => {
      if (editorOnly && service.mode !== 'editor') throw new Error('播放器不支持工程编辑。');
      return fn(...args);
    });
    if (registered.has(name)) return;
    registered.add(name);
    ipcMain.handle(name, (event, ...args) => {
      const handler = rendererHandlers.get(event.sender.id)?.get(name);
      if (!handler || event.senderFrame !== event.sender.mainFrame)
        throw new Error('拒绝非工程窗口请求。');
      return handler(...args);
    });
  };
  const agentModels = new AgentModelService(agentSettings, net.fetch);
  const skillRuns = new AgentSkillRuns(agentSkills);
  const mediaJobs = new MediaJobService(app.getPath('userData'));
  const worldReferences = new WorldReferenceService(
    service,
    agentSettings,
    referenceQueue,
    agentModels,
  );
  const revealed = new Set<string>();
  handle(
    'agent:model:complete',
    (input, streamId?: number) =>
      agentModels.complete(
        input,
        Number.isSafeInteger(streamId)
          ? (delta) => {
              if (!win.isDestroyed()) win.webContents.send('agent:model:delta', streamId, delta);
            }
          : undefined,
      ),
    true,
  );
  handle(
    'agent:model:cancel',
    (runId) => {
      if (typeof runId !== 'string' || runId.length > 160) throw new Error('运行 ID 无效。');
      agentModels.cancel(runId);
      skillRuns.cancel(runId);
    },
    true,
  );
  handle('agent:sessions:list', (projectId) => agentSessions.list(projectId), true);
  handle('agent:creative:load', (projectId) => agentSessions.loadCreativeDraft(projectId), true);
  handle(
    'agent:creative:save',
    (projectId, draft) => agentSessions.saveCreativeDraft(projectId, draft),
    true,
  );
  handle(
    'agent:sessions:load',
    (projectId, sessionId) => agentSessions.load(projectId, sessionId),
    true,
  );
  handle('agent:sessions:save', (session) => agentSessions.save(session), true);
  handle(
    'agent:sessions:delete',
    (projectId, sessionId) => agentSessions.delete(projectId, sessionId),
    true,
  );
  const stopAgentRequests = () => {
    agentModels.cancelAll();
    skillRuns.cancelAll();
    worldReferences.cancelAll();
  };
  win.webContents.on('render-process-gone', stopAgentRequests);
  win.webContents.on('did-start-loading', stopAgentRequests);
  win.on('closed', () => {
    stopAgentRequests();
    projectWindows.delete(win);
    assetScopes.delete(scope);
    rendererHandlers.delete(senderId);
    if (recentEditor === win) recentEditor = [...projectWindows.keys()].at(-1);
  });
  handle('agent:settings:get', () => agentSettings.get(), true);
  handle('agent:settings:save', (input) => agentSettings.save(input), true);
  handle('agent:skills:refresh', () => agentSkills.refresh(), true);
  handle(
    'agent:skills:open-root',
    async () => {
      const { catalog } = await agentSkills.current();
      const directory = await fs.stat(catalog.root).catch(() => null);
      if (!directory?.isDirectory()) throw new Error('技能目录不可用，请重新选择目录。');
      if (await shell.openPath(catalog.root)) throw new Error('无法打开技能目录。');
    },
    true,
  );
  handle('agent:skills:begin', (runId) => skillRuns.begin(runId), true);
  handle('agent:skills:read', (runId, input) => skillRuns.read(runId, input), true);
  handle('agent:skills:preview', (input) => skillRuns.preview(input), true);
  handle(
    'agent:skills:choose-root',
    async () => {
      const result = await dialog.showOpenDialog(win, {
        title: '选择本地技能目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      const root = result.canceled ? undefined : result.filePaths[0];
      return root ? agentSkills.refresh(root) : null;
    },
    true,
  );
  handle('agent:connection:test', (input) => agentSettings.test(input), true);
  handle('agent:connection:cancel', () => agentSettings.cancelConnectionTest(), true);
  handle('agent:codex:find', () => agentSettings.findCodexPrograms(), true);
  handle('agent:codex:models', (cliPath) => agentSettings.listCodexModels(cliPath), true);
  handle(
    'agent:codex:choose',
    async () => {
      const result = await dialog.showOpenDialog(win, {
        title: '选择 Codex CLI 程序',
        properties: ['openFile'],
        ...(process.platform === 'win32'
          ? { filters: [{ name: 'Codex CLI', extensions: ['exe', 'cmd'] }] }
          : {}),
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    true,
  );
  // A renderer reload must receive the latest opened/saved project, not the startup snapshot.
  handle('project:bootstrap', () => service.result(boot.recovered));
  handle('project:open', () => openProject(win, service, false, stopAgentRequests), true);
  handle('project:open-in-window', () => openProject(win, service, true, stopAgentRequests), true);
  handle(
    'project:save',
    (p, saveAs) => service.save(p, saveAs, (file) => reserveFile(file, service)),
    true,
  );
  handle(
    'project:autosave',
    (p, requireWrite) => {
      if (p?.id !== service.project.id) throw new Error('工程已切换，无法保存旧工程快照。');
      return service.autosave(p, requireWrite === true);
    },
    true,
  );
  handle(
    'project:default-directory',
    (title) => ProjectService.defaultProjectDirectory(typeof title === 'string' ? title : ''),
    true,
  );
  handle('project:choose-directory', () => ProjectService.chooseProjectDirectory(win), true);
  handle(
    'project:new',
    (p, directory) =>
      service.newProject(p, directory, (file) => reserveFile(file, service), stopAgentRequests),
    true,
  );
  handle('project:version-assets', (p, ids) => service.ensureVersionAssets(p, ids), true);
  handle('media:import', (kind, audioCategory) => service.import(kind, win, audioCategory), true);
  handle(
    'media:stage-import',
    async (projectId, audioCategory, operationId) => {
      if (typeof projectId !== 'string' || projectId !== service.project.id)
        throw new Error('工程已切换，请重新选择文件。');
      const root = service.root;
      const assets = operationId
        ? await mediaJobs.run(operationId, { projectId, root, audioCategory, kind: 'import' }, () =>
            service.import(undefined, win, audioCategory, projectId),
          )
        : await service.import(undefined, win, audioCategory, projectId);
      if (service.project.id !== projectId || service.root !== root)
        throw new Error('工程已切换。');
      for (const asset of assets) {
        await fs.access(safePath(root, asset.path));
        service.registerGeneratedAsset(root, asset);
      }
      return assets;
    },
    true,
  );
  handle(
    'media:reveal',
    async (projectId, assetId) => {
      if (projectId !== service.project.id || typeof assetId !== 'string')
        throw new Error('工程已切换或素材无效。');
      const root = service.root;
      const file = await service.asset(assetId, false);
      const appPath = app.getAppPath();
      const target =
        path.extname(appPath) === '.asar' && file.startsWith(appPath + path.sep) ? appPath : file;
      const stat = await fs.stat(target).catch(() => null);
      if (projectId !== service.project.id || root !== service.root)
        throw new Error('工程已切换。');
      if (!stat?.isFile()) throw new Error('找不到素材文件，可能已被移动或删除。');
      shell.showItemInFolder(target);
    },
    true,
  );
  handle(
    'media:generate-world-reference',
    async (input) => {
      const root = service.root;
      if (!input || input.projectId !== service.project.id) throw new Error('工程已切换。');
      const [asset] = await mediaJobs.run(input.requestId, { ...input, root }, async () => [
        await worldReferences.generate(input, (id, status) => {
          if (!win.webContents.isDestroyed())
            win.webContents.send('media:world-reference-status', id, status);
        }),
      ]);
      if (service.root !== root || service.project.id !== input.projectId)
        throw new Error('工程已切换。');
      await fs.access(safePath(root, asset.path));
      service.registerGeneratedAsset(root, asset);
      return asset;
    },
    true,
  );
  handle('media:cancel-world-reference', (id) => worldReferences.cancel(id), true);
  handle(
    'app:ready',
    (ready) => {
      editorReady = ready === true;
    },
    true,
  );
  handle(
    'app:complete-close',
    (saved) => {
      closePending = false;
      if (saved === true) {
        allowClose = true;
        win.close();
      }
    },
    true,
  );
  handle(
    'project:export',
    async (p, target) => {
      const output = await service.export(p, target);
      if (output) revealed.add(output);
      return output;
    },
    true,
  );
  handle(
    'file:reveal',
    async (target) => {
      if (!revealed.has(target)) throw new Error('路径未获授权。');
      await shell.openPath(target);
    },
    true,
  );
  win.webContents.setWindowOpenHandler(({ url }) => {
    const target = URL.parse(url);
    if (target && (target.protocol === 'https:' || target.protocol === 'http:')) {
      void shell.openExternal(target.href).catch(() => {});
    }
    return { action: 'deny' };
  });
  win.on('close', (event) => {
    if (service.mode === 'player' || allowClose || !editorReady || win.webContents.isDestroyed())
      return;
    event.preventDefault();
    if (!closePending) {
      closePending = true;
      worldReferences.cancelAll();
      win.webContents.send('app:before-close');
    }
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.once('ready-to-show', () => {
    if (process.env.FRAMEFORGE_TEST !== '1') win.show();
  });
  if (process.env.VITE_DEV_SERVER_URL && service.mode === 'editor')
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await win.loadFile(path.join(service.rendererRoot, 'index.html'));
  return win;
}

const ownsEditor =
  standalone ||
  !app.isPackaged ||
  process.env.FRAMEFORGE_TEST === '1' ||
  app.requestSingleInstanceLock();
if (!ownsEditor) app.quit();
else {
  app.on('second-instance', () => recentEditor?.focus());
  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null);
      agentSettings = new AgentSettingsService(
        app.getPath('userData'),
        safeStorage,
        process.env,
        net.fetch,
      );
      agentSessions = new AgentSessionService(app.getPath('userData'));
      const workspaceSkills = !dataOverride && workspace ? path.join(workspace, 'skills') : undefined;
      const bundledSkills = path.join(process.resourcesPath, 'bundled-skills');
      const defaultSkills =
        workspaceSkills && (existsSync(workspaceSkills) || !app.isPackaged)
          ? workspaceSkills
          : !standalone && app.isPackaged && existsSync(bundledSkills)
            ? bundledSkills
            : undefined;
      agentSkills = new AgentSkillService(app.getPath('userData'), defaultSkills);
      if (!standalone) void agentSkills.current();
      app.on('before-quit', () => agentSettings.cancelTest());
      registerAssetProtocol();
      let window: BrowserWindow | undefined;
      const service = new ProjectService(
        rendererRoot,
        __dirname,
        () => !!window && recentEditor === window,
      );
      const boot = await service.boot();
      window = await createWindow(service, boot);
    })
    .catch((error: Error) => {
      dialog.showErrorBox('帧叙', error.message);
      app.quit();
    });
}
app.on('window-all-closed', () => app.quit());
