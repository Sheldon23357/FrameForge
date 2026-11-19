import { strToU8, zipSync } from 'fflate';
import type { Project } from '../../packages/domain/schema';
import { validateProject } from '../../packages/domain/validation';
import { webAssetPath, webInstructions } from '../../packages/export/web';
import { prepareGameProject } from '../../packages/export/project';
import { browserAssetUrl, download } from './browser';

export async function exportWebGame(project: Project): Promise<string> {
  const errors = validateProject(project).filter((issue) => issue.severity === 'error');
  if (errors.length) throw new Error(`请先修复 ${errors.length} 个工程错误。`);
  const runtimeBase = `${import.meta.env.BASE_URL}web-player/`;
  const manifestResponse = await fetch(`${runtimeBase}manifest.json`);
  if (!manifestResponse.ok) throw new Error('网页播放器尚未构建，请重新启动编辑器或重新构建应用。');
  const manifest: unknown = await manifestResponse.json();
  if (!Array.isArray(manifest) || !manifest.every((file) => typeof file === 'string'))
    throw new Error('网页播放器文件清单无效。');
  const files: Record<string, Uint8Array> = {};
  for (const file of manifest as string[]) {
    const relative = webAssetPath(file);
    const response = await fetch(`${runtimeBase}${relative}`);
    if (!response.ok) throw new Error(`无法读取网页播放器文件 ${relative}。`);
    files[relative] = new Uint8Array(await response.arrayBuffer());
  }
  if (!files['index.html']) throw new Error('网页播放器缺少 index.html。');
  for (const asset of project.assets) {
    for (const relative of [asset.path, asset.thumbnail]) {
      if (!relative || relative.startsWith('data:')) continue;
      const destination = `game/files/${webAssetPath(relative)}`;
      if (files[destination]) continue;
      const url = browserAssetUrl({ ...asset, path: relative });
      if (!url) throw new Error(`素材「${asset.name}」无法读取。`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`素材「${asset.name}」无法读取。`);
      files[destination] = new Uint8Array(await response.arrayBuffer());
    }
  }
  if (project.assets.some((asset) => asset.builtin && asset.path.startsWith('demo/'))) {
    const response = await fetch(`${import.meta.env.BASE_URL}demo/CREDITS.txt`);
    if (!response.ok) throw new Error('无法读取示例素材授权说明。');
    files['game/files/demo/CREDITS.txt'] = new Uint8Array(await response.arrayBuffer());
  }
  files['game/project.json'] = strToU8(JSON.stringify(prepareGameProject(project)));
  files['部署说明.txt'] = strToU8(webInstructions);
  const name = `${project.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'My Game'}-web.zip`;
  const archive = zipSync(files, { level: 0 });
  download(new Blob([archive as Uint8Array<ArrayBuffer>]), name);
  return name;
}
