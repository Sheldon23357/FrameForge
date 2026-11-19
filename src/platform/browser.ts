import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { makeProject, parseProject, type Asset, type Project } from '../../packages/domain/schema';
import {
  assetCategory,
  importedAssetId,
  type AudioAssetCategory,
} from '../../packages/domain/assets';
import {
  worldReferenceExtensions,
  type WorldReferenceKind,
} from '../../packages/domain/world-settings';
import { BootResult } from './types';
import type { ExportTarget } from '../../packages/export/web';
const projectKey = 'frameforge.project.v1';
const urls = new Map<string, string>();
let currentId = '';
async function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('frameforge-media', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('assets');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function put(key: string, blob: Blob) {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('assets', 'readwrite');
    tx.objectStore('assets').put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  database.close();
}
async function get(key: string): Promise<Blob | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('assets');
    const r = tx.objectStore('assets').get(key);
    r.onsuccess = () => {
      resolve(r.result);
      database.close();
    };
    r.onerror = () => reject(r.error);
  });
}
function cache(path: string, blob: Blob) {
  const old = urls.get(path);
  if (old) URL.revokeObjectURL(old);
  urls.set(path, URL.createObjectURL(blob));
}
async function hydrate(p: Project) {
  urls.forEach((url) => URL.revokeObjectURL(url));
  urls.clear();
  currentId = p.id;
  for (const a of p.assets)
    if (!a.builtin) {
      for (const path of [a.path, a.thumbnail].filter(
        (s): s is string => !!s && !s.startsWith('data:'),
      )) {
        const blob = await get(`${p.id}/${path}`);
        if (blob) cache(path, blob);
      }
    }
}
export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
function selectFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.oncancel = () => resolve([]);
    input.click();
  });
}
export function browserAssetUrl(a: Asset, thumbnail = false) {
  const relative = thumbnail ? (a.thumbnail ?? a.path) : a.path;
  if (relative.startsWith('data:')) return relative;
  if (a.builtin) return `${import.meta.env.BASE_URL}${relative}`;
  return urls.get(relative) ?? '';
}
export async function probeMedia(
  url: string,
  type: Asset['type'],
): Promise<{ durationMs: number; width: number; height: number; thumbnail?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: {
      durationMs: number;
      width: number;
      height: number;
      thumbnail?: string;
    }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ durationMs: 0, width: 0, height: 0 }), 8000);
    if (type === 'image') {
      const img = new Image();
      img.onload = () =>
        finish({ durationMs: 0, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => finish({ durationMs: 0, width: 0, height: 0 });
      img.src = url;
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const result = {
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0,
        width: video.videoWidth,
        height: video.videoHeight,
        thumbnail: undefined as string | undefined,
      };
      if (type === 'audio') {
        video.removeAttribute('src');
        video.load();
        finish(result);
        return;
      }
      video.onseeked = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 480;
          canvas.height = (480 * video.videoHeight) / video.videoWidth;
          canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
          result.thumbnail = canvas.toDataURL('image/jpeg', 0.75);
        } catch {}
        video.removeAttribute('src');
        video.load();
        finish(result);
      };
      video.currentTime = Math.min(0.5, video.duration / 2);
    };
    video.onerror = () => finish({ durationMs: 0, width: 0, height: 0 });
    video.src = url;
  });
}
async function packProject(p: Project) {
  const files: Record<string, Uint8Array> = {
    'project.frameforge': strToU8(JSON.stringify(p, null, 2)),
  };
  for (const a of p.assets) {
    for (const path of [a.path, a.thumbnail].filter(
      (x): x is string => !!x && !x.startsWith('data:'),
    )) {
      const response = await fetch(browserAssetUrl({ ...a, path }, false));
      if (!response.ok) throw new Error(`素材「${a.name}」无法读取。`);
      files[path] = new Uint8Array(await response.arrayBuffer());
    }
  }
  if (p.assets.some((asset) => asset.builtin && asset.path.startsWith('demo/'))) {
    const credits = await fetch(`${import.meta.env.BASE_URL}demo/CREDITS.txt`);
    if (credits.ok) files['demo/CREDITS.txt'] = new Uint8Array(await credits.arrayBuffer());
  }
  return zipSync(files, { level: 0 });
}
export const browserPlatform = {
  async bootstrap(): Promise<BootResult> {
    let project = makeProject();
    let recovered = false;
    try {
      const raw = localStorage.getItem(projectKey);
      if (raw) {
        project = parseProject(JSON.parse(raw));
        recovered = true;
      }
    } catch {}
    await hydrate(project);
    return { project, mode: 'editor', recovered, ffmpeg: false };
  },
  async openProject(): Promise<BootResult | null> {
    const [file] = await selectFiles('.frameforge,.json,.zip');
    if (!file) return null;
    let project: Project;
    const buffer = new Uint8Array(await file.arrayBuffer());
    if (buffer[0] === 80 && buffer[1] === 75) {
      const archive = unzipSync(buffer);
      const metadata = archive['project.frameforge'];
      if (!metadata) throw new Error('压缩包缺少 project.frameforge。');
      project = parseProject(JSON.parse(strFromU8(metadata)));
      for (const a of project.assets) {
        for (const path of [a.path, a.thumbnail].filter(
          (x): x is string => !!x && !x.startsWith('data:'),
        )) {
          if (archive[path]) {
            await put(
              `${project.id}/${path}`,
              new Blob([archive[path] as Uint8Array<ArrayBuffer>]),
            );
            a.builtin = false;
          }
        }
      }
    } else project = parseProject(JSON.parse(strFromU8(buffer)));
    await hydrate(project);
    localStorage.setItem(projectKey, JSON.stringify(project));
    return { project, mode: 'editor', ffmpeg: false };
  },
  async saveProject(p: Project) {
    const archive = await packProject(p);
    download(new Blob([archive as Uint8Array<ArrayBuffer>]), `${p.title}.frameforge.zip`);
    return '已下载工程压缩包';
  },
  async autosave(p: Project) {
    localStorage.setItem(projectKey, JSON.stringify(p));
  },
  async ensureVersionAssets(p: Project, ids: string[]) {
    if (currentId !== p.id) throw new Error('工程已切换，无法回退。');
    const selected = new Set(ids);
    const loaded = new Map<string, Blob>();
    for (const asset of p.assets) {
      if (!selected.has(asset.id) || asset.builtin) continue;
      for (const path of [asset.path, asset.thumbnail]) {
        if (!path || path.startsWith('data:') || urls.has(path) || loaded.has(path)) continue;
        const blob = await get(p.id + '/' + path);
        if (!blob) throw new Error('当前工程缺少素材「' + asset.name + '」，无法回退到该版本。');
        loaded.set(path, blob);
      }
    }
    if (currentId !== p.id) throw new Error('工程已切换，无法回退。');
    for (const [path, blob] of loaded) cache(path, blob);
  },
  async newProject(p: Project) {
    await hydrate(p);
    localStorage.setItem(projectKey, JSON.stringify(p));
  },
  async importAssets(
    kind?: WorldReferenceKind,
    audioCategory?: AudioAssetCategory,
  ): Promise<Asset[]> {
    const projectId = currentId;
    const filterKind = kind ?? (audioCategory ? 'audio' : undefined);
    const files = await selectFiles(
      filterKind
        ? worldReferenceExtensions[filterKind].map((extension) => `.${extension}`).join(',')
        : 'video/*,audio/*,image/png,image/jpeg,image/webp,.mp3,.wav,.ogg,.m4a,.aac,.flac',
      !kind,
    );
    const result: Asset[] = [];
    for (const file of files) {
      const extension = file.name.split('.').pop() ?? '';
      if (filterKind && !worldReferenceExtensions[filterKind].includes(extension.toLowerCase()))
        throw new Error(
          filterKind === 'image' ? '请选择支持的图片文件。' : '请选择支持的音频文件。',
        );
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const key = Array.from(new Uint8Array(digest))
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 24);
      const type =
        filterKind ??
        (file.type.startsWith('image/')
          ? 'image'
          : file.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(file.name)
            ? 'audio'
            : 'video');
      const category =
        kind === 'image'
          ? 'reference'
          : (audioCategory ?? assetCategory({ type, name: file.name, path: '' }));
      const path = `assets/${category}/${key}.${extension}`;
      await put(`${projectId}/${path}`, file);
      if (currentId !== projectId) throw new Error('工程已切换，请重新选择文件。');
      cache(path, file);
      const metadata = await probeMedia(urls.get(path)!, type);
      result.push({
        id: importedAssetId(key, category),
        name: file.name,
        path,
        type,
        size: file.size,
        builtin: false,
        ...metadata,
      });
    }
    return result;
  },
  async exportGame(project: Project, target: ExportTarget = 'windows'): Promise<string | null> {
    if (target === 'web') {
      const { exportWebGame } = await import('./web-export');
      return exportWebGame(project);
    }
    throw new Error('独立 Windows 游戏导出请使用桌面版本。浏览器中可保存包含素材的工程压缩包。');
  },
  async reveal() {},
};
