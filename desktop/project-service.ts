import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { audioAssetCategories } from '../packages/domain/assets';
import { makeProject, parseProject, type Asset, type Project } from '../packages/domain/schema';
import { prepareGameProject } from '../packages/export/project';
import { validateProject } from '../packages/domain/validation';
import {
  isGeneratedReferenceImage,
  worldReferenceExtensions,
  worldReferenceKind,
} from '../packages/domain/world-settings';
import {
  archiveReferenceImage,
  atomicWrite,
  copyProjectAssets,
  exists,
  locateAsset,
} from './files';
import { hasFfmpeg, importMedia } from './media';
import { BootResult } from '../src/platform/types';
import { webAssetPaths, webInstructions, type ExportTarget } from '../packages/export/web';
import { editorWorkspaceDirectory } from './editor-paths';
import { imageThumbnail } from './image-thumbnail';

export class ProjectService {
  project: Project = makeProject();
  root = '';
  filePath?: string;
  mode: 'editor' | 'player' = 'editor';
  private queue: Promise<unknown> = Promise.resolve();
  private generatedAssets = new Map<string, Asset>();
  private generatedAssetRoot = '';
  private readonly builtinMediaRoot: string;
  constructor(
    public rendererRoot: string,
    public desktopRoot: string,
    private rememberProject = () => true,
  ) {
    const workspacePublic = path.join(editorWorkspaceDirectory(), 'public');
    this.builtinMediaRoot = existsSync(path.join(workspacePublic, 'demo'))
      ? workspacePublic
      : rendererRoot;
  }
  private get recoveryFile() {
    return path.join(app.getPath('userData'), 'recovery.json');
  }
  async boot(): Promise<BootResult> {
    const gameFile = path.join(app.getAppPath(), 'game', 'project.json');
    if (await exists(gameFile)) {
      this.project = parseProject(JSON.parse(await fs.readFile(gameFile, 'utf8')));
      this.root = path.dirname(gameFile);
      this.mode = 'player';
      return this.result(false);
    }
    let recovered = false;
    try {
      const recovery = JSON.parse(await fs.readFile(this.recoveryFile, 'utf8'));
      this.project = parseProject(recovery.project);
      this.root = recovery.root;
      this.filePath = recovery.filePath;
      if (!path.isAbsolute(this.root)) throw new Error();
      if (this.filePath) {
        const saved = await ProjectService.readFile(this.filePath).catch(() => undefined);
        if (
          saved?.project.id === this.project.id &&
          !ProjectService.isNewer(this.project, saved.project)
        ) {
          this.project = saved.project;
        }
      }
      recovered = true;
    } catch {
      this.root = path.join(app.getPath('userData'), 'drafts', crypto.randomUUID());
    }
    await fs.mkdir(this.root, { recursive: true });
    return this.result(recovered);
  }
  async result(recovered = false): Promise<BootResult> {
    return {
      project: this.project,
      mode: this.mode,
      filePath: this.filePath,
      recovered,
      ffmpeg: await hasFfmpeg(),
    };
  }
  private static productionsDirectory() {
    const base =
      process.env.FRAMEFORGE_TEST === '1' ? app.getPath('userData') : editorWorkspaceDirectory();
    return path.join(base, 'productions');
  }
  static defaultProjectDirectory(title: string) {
    let folder = title
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .trim()
      .slice(0, 100)
      .replace(/[. ]+$/, '');
    if (!folder) folder = '我的互动影游';
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(folder)) folder = '_' + folder;
    return path.join(ProjectService.productionsDirectory(), folder);
  }
  static async chooseProjectDirectory(owner: BrowserWindow) {
    const result = await dialog.showOpenDialog(owner, {
      title: '选择或新建作品保存目录',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选择此目录',
    });
    if (result.canceled || !result.filePaths[0] || owner.isDestroyed()) return null;
    return fs.realpath(result.filePaths[0]);
  }
  async newProject(
    raw: unknown,
    directory: unknown,
    reserve: (file: string) => Promise<() => void>,
    beforeReplace: () => void,
  ): Promise<string> {
    const project = parseProject(raw);
    if (directory !== undefined && (typeof directory !== 'string' || !path.isAbsolute(directory)))
      throw new Error('请选择有效的作品目录。');
    const destination = directory ?? ProjectService.defaultProjectDirectory(project.title);
    if (directory === undefined) await fs.mkdir(destination, { recursive: true });
    const root = await fs.realpath(destination);
    const file = path.join(root, 'project.frameforge');
    const release = await reserve(file);
    try {
      if ((await fs.readdir(root)).length)
        throw new Error('请选择空文件夹，或新建一个作品文件夹。');
      await fs.writeFile(file, JSON.stringify(project, null, 2), { flag: 'wx' });
      beforeReplace();
      this.root = root;
      this.filePath = file;
      // The project file is already saved. The editor retries autosave after loading it.
      await this.autosave(project).catch((error) => console.warn('新作品自动保存失败', error));
      return file;
    } finally {
      release();
    }
  }
  async chooseFile(owner: BrowserWindow): Promise<string | undefined> {
    const library = ProjectService.productionsDirectory();
    const libraryRoot = await fs.realpath(library).catch(() => library);
    const current = this.filePath && path.dirname(this.filePath);
    const currentRoot = current && (await fs.realpath(current).catch(() => undefined));
    const relative = currentRoot && path.relative(libraryRoot, currentRoot);
    const outsideLibrary =
      relative &&
      (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative));
    const defaultPath = outsideLibrary
      ? currentRoot
      : await fs.mkdir(libraryRoot, { recursive: true }).then(
          () => libraryRoot,
          () => currentRoot || app.getPath('documents'),
        );
    if (owner.isDestroyed()) return undefined;
    const result = await dialog.showOpenDialog(owner, {
      title: '打开帧叙工程',
      defaultPath,
      filters: [{ name: 'FrameForge 工程', extensions: ['frameforge', 'json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return undefined;
    return fs.realpath(result.filePaths[0]);
  }
  private static autosavePath(root: string, file?: string) {
    const name = file ? path.basename(file) : 'project.frameforge';
    return path.join(
      root,
      name.toLowerCase() === 'project.frameforge'
        ? 'autosave.frameforge'
        : `${name}.autosave.frameforge`,
    );
  }
  private static isNewer(candidate: Project, baseline: Project) {
    return (
      candidate.revision > baseline.revision ||
      (candidate.revision === baseline.revision &&
        Date.parse(candidate.updatedAt) > Date.parse(baseline.updatedAt))
    );
  }
  static async readFile(file: string): Promise<{ project: Project; recovered: boolean }> {
    const stat = await fs.stat(file);
    if (stat.size > 30_000_000) throw new Error('工程文件过大。');
    const project = parseProject(JSON.parse(await fs.readFile(file, 'utf8')));
    const autosave = ProjectService.autosavePath(path.dirname(file), file);
    try {
      const saved = await fs.stat(autosave);
      if (saved.size <= 30_000_000) {
        const recovered = parseProject(JSON.parse(await fs.readFile(autosave, 'utf8')));
        if (recovered.id === project.id && ProjectService.isNewer(recovered, project))
          return { project: recovered, recovered: true };
      }
    } catch {
      // The explicit project remains usable if its autosave is unavailable.
    }
    return { project, recovered: false };
  }
  async openFile(
    file: string,
    loaded: Awaited<ReturnType<typeof ProjectService.readFile>>,
  ): Promise<BootResult> {
    const { project, recovered } = loaded;
    this.project = project;
    this.root = path.dirname(file);
    this.filePath = file;
    await this.autosave(project);
    return this.result(recovered);
  }
  async save(
    raw: unknown,
    saveAs = false,
    reserve: (file: string) => Promise<() => void> = async () => () => {},
  ): Promise<string | null> {
    const project = parseProject(raw);
    let file = this.filePath;
    if (saveAs || !file) {
      const r = await dialog.showSaveDialog({
        title: '保存工程（素材会一起复制到 assets 目录）',
        defaultPath: `${project.title}/project.frameforge`,
        filters: [{ name: 'FrameForge 工程', extensions: ['frameforge'] }],
      });
      if (r.canceled || !r.filePath) return null;
      file = r.filePath;
    }
    const release = await reserve(file);
    try {
      const root = path.dirname(file);
      await copyProjectAssets(project, this.root, root, this.builtinMediaRoot);
      if (await exists(file)) await fs.copyFile(file, `${file}.bak`);
      await atomicWrite(file, JSON.stringify(project, null, 2));
      this.project = project;
      this.root = root;
      this.filePath = file;
      await this.autosave(project);
      return file;
    } finally {
      release();
    }
  }
  async autosave(raw: unknown, requireWrite = false) {
    if (this.mode === 'player') return;
    const project = parseProject(raw);
    const previous = this.project;
    const paths = new Set(project.assets.flatMap(({ path, thumbnail }) => [path, thumbnail]));
    const removed =
      previous.id === project.id
        ? previous.assets.filter(
            (asset) => isGeneratedReferenceImage(asset) && !paths.has(asset.path),
          )
        : [];
    this.project = project;
    for (const asset of project.assets) this.generatedAssets.delete(asset.id);
    const content = JSON.stringify({ project, root: this.root, filePath: this.filePath });
    const root = this.root;
    const filePath = this.filePath;
    const autosave = ProjectService.autosavePath(root, filePath);
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        if (filePath) {
          const saved = await ProjectService.readFile(filePath).catch(() => undefined);
          if (saved?.project.id === project.id && ProjectService.isNewer(saved.project, project)) {
            if (requireWrite) throw new Error('磁盘上已有更新版本，当前 Agent 修改尚未保存。');
            return;
          }
        }
        await atomicWrite(autosave, JSON.stringify(project, null, 2));
        if (this.rememberProject()) await atomicWrite(this.recoveryFile, content);
        if (this.root === root && this.project.id === project.id) {
          const activePaths = new Set(
            this.project.assets.flatMap(({ path, thumbnail }) => [path, thumbnail]),
          );
          for (const asset of removed) {
            if (activePaths.has(asset.path) || this.generatedAssets.has(asset.id)) continue;
            // Keep the bytes available to undo, older saves and project history.
            await archiveReferenceImage(root, asset.path).catch((error) =>
              console.warn('无法归档旧参考图', error),
            );
          }
        }
      });
    await this.queue;
  }
  registerGeneratedAsset(root: string, asset: Asset) {
    if (this.generatedAssetRoot !== root) {
      this.generatedAssets.clear();
      this.generatedAssetRoot = root;
    }
    this.generatedAssets.set(asset.id, asset);
    if (this.generatedAssets.size > 128)
      this.generatedAssets.delete(this.generatedAssets.keys().next().value!);
  }
  async import(
    rawKind: unknown,
    owner: BrowserWindow,
    rawAudioCategory?: unknown,
    stagedProjectId?: string,
  ) {
    const kind = worldReferenceKind.optional().parse(rawKind);
    const audioCategory = z.enum(audioAssetCategories).optional().parse(rawAudioCategory);
    const filterKind = kind ?? (audioCategory ? 'audio' : undefined);
    const root = this.root;
    const projectId = this.project.id;
    if (stagedProjectId !== undefined && stagedProjectId !== projectId)
      throw new Error('工程已切换，请重新选择文件。');
    const verifyProject = () => {
      if (root !== this.root || projectId !== this.project.id)
        throw new Error('工程已切换，请重新选择文件。');
    };
    const name =
      filterKind === 'image' ? '图片' : filterKind === 'audio' ? '音频' : '视频、图片与音频';
    const r = await dialog.showOpenDialog(owner, {
      title: filterKind ? `选择${name}文件` : '导入视频、图片或音频',
      properties: kind ? ['openFile'] : ['openFile', 'multiSelections'],
      filters: [
        {
          name,
          extensions: filterKind
            ? worldReferenceExtensions[filterKind]
            : [
                'mp4',
                'webm',
                'mov',
                'm4v',
                'mkv',
                ...worldReferenceExtensions.image,
                ...worldReferenceExtensions.audio,
              ],
        },
      ],
    });
    if (r.canceled) return [];
    verifyProject();
    const files = kind ? r.filePaths.slice(0, 1) : r.filePaths;
    if (
      filterKind &&
      files.some(
        (file) =>
          !worldReferenceExtensions[filterKind].includes(path.extname(file).slice(1).toLowerCase()),
      )
    )
      throw new Error(`请选择支持的${name}文件。`);
    const assets = [];
    for (const file of files) {
      const category = kind === 'image' ? 'reference' : audioCategory;
      assets.push(await importMedia(file, root, category));
    }
    verifyProject();
    for (const asset of assets) {
      if (this.project.assets.some((old) => old.id === asset.id)) continue;
      if (kind || stagedProjectId !== undefined) this.registerGeneratedAsset(root, asset);
      else this.project.assets.push(asset);
    }
    return assets;
  }
  async ensureVersionAssets(raw: unknown, rawIds: unknown) {
    const project = parseProject(raw);
    if (
      project.id !== this.project.id ||
      !Array.isArray(rawIds) ||
      rawIds.some((id) => typeof id !== 'string')
    )
      throw new Error('工程已切换，无法回退。');
    const ids = new Set(rawIds);
    const root = this.root;
    for (const asset of project.assets) {
      if (!ids.has(asset.id)) continue;
      for (const relative of [asset.path, asset.thumbnail]) {
        if (!relative || relative.startsWith('data:')) continue;
        if (!(await exists(await locateAsset(root, this.builtinMediaRoot, relative, asset.builtin))))
          throw new Error('当前工程缺少素材「' + asset.name + '」，无法回退到该版本。');
      }
    }
    if (root !== this.root || project.id !== this.project.id)
      throw new Error('工程已切换，无法回退。');
  }
  async asset(id: string, thumbnail: boolean) {
    const a =
      this.project.assets.find((a) => a.id === id) ??
      (this.root === this.generatedAssetRoot ? this.generatedAssets.get(id) : undefined);
    if (!a) throw new Error('找不到素材。');
    const relative = thumbnail ? (a.thumbnail ?? a.path) : a.path;
    const file = await locateAsset(this.root, this.builtinMediaRoot, relative, a.builtin);
    if (this.mode !== 'editor' || !thumbnail || a.type !== 'image' || relative !== a.path)
      return file;
    const cache = path.join(app.getPath('userData'), 'Cache', 'frameforge-thumbnails-v1');
    return imageThumbnail(file, cache).catch(() => file);
  }
  async export(raw: unknown, target: ExportTarget = 'windows'): Promise<string | null> {
    if (target !== 'windows' && target !== 'web') throw new Error('不支持的导出格式。');
    const project = prepareGameProject(parseProject(raw));
    const errors = validateProject(project).filter((d) => d.severity === 'error');
    if (errors.length) throw new Error(`请先修复 ${errors.length} 个工程错误。`);
    const result = await dialog.showOpenDialog({
      title: target === 'web' ? '选择网页版游戏的导出位置' : '选择独立游戏的导出位置',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled) return null;
    const name = project.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60) || 'My Game';
    const runtime = path.dirname(process.execPath);
    const output = path.join(
      result.filePaths[0],
      `${name}${target === 'web' ? '-web' : ''}-${Date.now()}`,
    );
    const withinRuntime = path.relative(runtime, output);
    if (!withinRuntime.startsWith('..') && !path.isAbsolute(withinRuntime))
      throw new Error('请选择应用程序目录之外的导出位置。');
    await fs.mkdir(output, { recursive: true });
    if (target === 'web') {
      webAssetPaths(project);
      const webRuntime = path.join(this.rendererRoot, 'web-player');
      if (!(await exists(path.join(webRuntime, 'index.html'))))
        throw new Error('网页播放器尚未构建，请重新启动编辑器或重新构建应用。');
      await fs.cp(webRuntime, output, { recursive: true });
      const gameRoot = path.join(output, 'game');
      await copyProjectAssets(project, this.root, path.join(gameRoot, 'files'), this.builtinMediaRoot);
      await atomicWrite(path.join(gameRoot, 'project.json'), JSON.stringify(project));
      await atomicWrite(path.join(output, '部署说明.txt'), webInstructions);
      return output;
    }
    for (const entry of await fs.readdir(runtime, { withFileTypes: true })) {
      if (['resources', 'version', '.local', 'skills'].includes(entry.name)) continue;
      // Only the Electron distribution is copied, never parent workspace files.
      await fs.cp(path.join(runtime, entry.name), path.join(output, entry.name), {
        recursive: true,
      });
    }
    const appRoot = path.join(output, 'resources', 'app');
    await fs.mkdir(appRoot, { recursive: true });
    await fs.cp(this.rendererRoot, path.join(appRoot, 'dist'), { recursive: true });
    await fs.cp(this.desktopRoot, path.join(appRoot, 'dist-desktop'), { recursive: true });
    await fs.writeFile(
      path.join(appRoot, 'package.json'),
      JSON.stringify({
        name: 'frameforge-player',
        version: '1.0.0',
        main: 'dist-desktop/main.cjs',
      }),
    );
    const gameRoot = path.join(appRoot, 'game');
    await fs.mkdir(gameRoot, { recursive: true });
    await copyProjectAssets(project, this.root, gameRoot, this.builtinMediaRoot);
    await atomicWrite(path.join(gameRoot, 'project.json'), JSON.stringify(project));
    const oldExe = path.basename(process.execPath);
    const exePath = path.join(output, oldExe);
    if (await exists(exePath)) await fs.rename(exePath, path.join(output, `${name}.exe`));
    await fs.writeFile(
      path.join(output, '使用说明.txt'),
      `双击 ${name}.exe 开始游戏。请保持资源目录完整。\n游玩时按住 Ctrl 以 10 倍速播放，松开恢复正常速度。\n游戏存档保存在当前用户的应用数据目录。\n本播放器由帧叙制作。\n`,
    );
    return output;
  }
}
