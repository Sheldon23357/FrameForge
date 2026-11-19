import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Asset } from '../packages/domain/schema';
import { assetCategory, importedAssetId, type AssetCategory } from '../packages/domain/assets';
const execute = promisify(execFile);
export async function hasFfmpeg() {
  try {
    await execute('ffmpeg', ['-version'], { windowsHide: true, timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}
export async function importMedia(
  file: string,
  root: string,
  category?: AssetCategory,
): Promise<Asset> {
  const extension = path.extname(file).toLowerCase();
  if (
    ![
      '.mp4',
      '.webm',
      '.mov',
      '.m4v',
      '.mkv',
      '.jpg',
      '.jpeg',
      '.png',
      '.webp',
      '.mp3',
      '.wav',
      '.ogg',
      '.m4a',
      '.aac',
      '.flac',
    ].includes(extension)
  )
    throw new Error('暂不支持此素材格式。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const key = hash.digest('hex').slice(0, 24);
  const name = path.basename(file);
  const type: Asset['type'] = ['.jpg', '.jpeg', '.png', '.webp'].includes(extension)
    ? 'image'
    : ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'].includes(extension)
      ? 'audio'
      : 'video';
  const storageCategory = category ?? assetCategory({ type, name, path: '' });
  const directory = `assets/${storageCategory}`;
  const target = `${directory}/${key}${extension}`;
  await fs.mkdir(path.join(root, directory), { recursive: true });
  if (path.resolve(file) !== path.resolve(root, target))
    await fs.copyFile(file, path.join(root, target));
  const stat = await fs.stat(file);
  let durationMs = 0,
    width = 0,
    height = 0;
  try {
    const { stdout } = await execute(
      'ffprobe',
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
      { windowsHide: true, timeout: 15000, maxBuffer: 2_000_000 },
    );
    const info = JSON.parse(stdout);
    const video = info.streams?.find((s: { codec_type: string }) => s.codec_type === 'video');
    durationMs = Math.round(Number(info.format?.duration || 0) * 1000);
    width = Number(video?.width || 0);
    height = Number(video?.height || 0);
  } catch {
    /* Renderer probes standard media if the optional system tools are unavailable. */
  }
  let thumbnail: string | undefined = type === 'image' ? target : undefined;
  if (type === 'video') {
    try {
      await execute(
        'ffmpeg',
        [
          '-y',
          '-ss',
          String(Math.min(1, durationMs / 2000)),
          '-i',
          file,
          '-frames:v',
          '1',
          '-vf',
          'scale=640:-2',
          path.join(root, `${directory}/${key}.jpg`),
        ],
        { windowsHide: true, timeout: 30000, maxBuffer: 2_000_000 },
      );
      thumbnail = `${directory}/${key}.jpg`;
    } catch {
      /* No thumbnail is still a valid import. */
    }
  }
  return {
    id: importedAssetId(key, storageCategory),
    name,
    path: target,
    type,
    size: stat.size,
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    width,
    height,
    thumbnail,
    builtin: false,
  };
}
