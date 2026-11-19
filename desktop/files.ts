import path from 'node:path';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { Project } from '../packages/domain/schema';

const referenceImagePath = /^assets\/(?:reference\/)?[a-f0-9]{24}\.png$/;

export function safePath(root: string, relative: string): string {
  if (!relative || relative.includes('\0') || path.isAbsolute(relative) || relative.includes(':'))
    throw new Error('素材路径无效。');
  const result = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), result);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('素材路径超出工程目录。');
  return result;
}
export async function atomicWrite(file: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content);
    for (const delay of [50, 100, 200, 400, 800, 0]) {
      try {
        await fs.rename(temporary, file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          !delay ||
          process.platform !== 'win32' ||
          !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')
        )
          throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  } catch (e) {
    await fs.unlink(temporary).catch(() => {});
    throw e;
  }
}
export async function exists(file: string) {
  return fs.access(file, constants.F_OK).then(
    () => true,
    () => false,
  );
}
export async function locateAsset(
  root: string,
  rendererRoot: string,
  relative: string,
  builtin: boolean,
): Promise<string> {
  const local = safePath(root, relative);
  if (await exists(local)) return local;
  if (builtin && relative.startsWith('demo/')) return safePath(rendererRoot, relative);
  if (!builtin && referenceImagePath.test(relative)) {
    const archived = safePath(root, `.frameforge/reference-history/${path.basename(relative)}`);
    if (await exists(archived)) return archived;
  }
  return local;
}

export async function archiveReferenceImage(root: string, relative: string) {
  if (!referenceImagePath.test(relative)) throw new Error('参考图路径无效。');
  const local = safePath(root, relative);
  if (!(await exists(local))) return;
  const archived = safePath(root, `.frameforge/reference-history/${path.basename(relative)}`);
  const realRoot = await fs.realpath(root);
  const sourceFolder = await fs.realpath(path.dirname(local));
  if (sourceFolder !== path.join(realRoot, path.dirname(relative)))
    throw new Error('参考图目录无效。');
  await fs.mkdir(path.dirname(archived), { recursive: true });
  const archiveFolder = await fs.realpath(path.dirname(archived));
  if (archiveFolder !== path.join(realRoot, '.frameforge', 'reference-history'))
    throw new Error('参考图历史目录无效。');
  await fs.rename(local, archived);
}
export async function copyProjectAssets(
  p: Project,
  sourceRoot: string,
  targetRoot: string,
  rendererRoot: string,
) {
  for (const a of p.assets) {
    for (const relative of [a.path, a.thumbnail].filter((s): s is string => !!s)) {
      if (relative.startsWith('data:')) continue;
      const from = await locateAsset(sourceRoot, rendererRoot, relative, a.builtin);
      const to = safePath(targetRoot, relative);
      if (path.resolve(from) === path.resolve(to)) continue;
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
  }
  if (p.assets.some((a) => a.builtin)) {
    const credit = safePath(rendererRoot, 'demo/CREDITS.txt');
    if (await exists(credit)) {
      await fs.mkdir(path.join(targetRoot, 'demo'), { recursive: true });
      await fs.copyFile(credit, path.join(targetRoot, 'demo/CREDITS.txt'));
    }
  }
}
