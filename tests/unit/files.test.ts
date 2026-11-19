import { describe, it, expect } from 'vitest';
import { archiveReferenceImage, safePath, atomicWrite, locateAsset } from '../../desktop/files';
import { importMedia } from '../../desktop/media';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { voicePreviewWav } from '../fixtures/voice-preview';
describe('project files', () => {
  it('stores the same audio format in the selected music or voice directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-audio-import-'));
    try {
      const file = path.join(root, 'test.wav');
      const original = Buffer.from(voicePreviewWav(), 'base64');
      await fs.writeFile(file, original);
      const ids = new Set<string>();
      for (const category of ['music', 'voice'] as const) {
        const asset = await importMedia(file, root, category);
        expect(asset).toMatchObject({
          type: 'audio',
          path: expect.stringContaining(`assets/${category}/`),
        });
        expect(await fs.readFile(safePath(root, asset.path))).toEqual(original);
        ids.add(asset.id);
      }
      expect(ids.size).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it.each(['assets', 'assets/reference'])(
    'archives references from %s and keeps them readable for undo',
    async (directory) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-reference-'));
      try {
        const relative = `${directory}/${'a'.repeat(24)}.png`;
        const original = safePath(root, relative);
        await atomicWrite(original, 'previous reference');
        await archiveReferenceImage(root, relative);
        await archiveReferenceImage(root, relative);
        await expect(fs.stat(original)).rejects.toMatchObject({ code: 'ENOENT' });
        const archived = await locateAsset(root, root, relative, false);
        expect(await fs.readFile(archived, 'utf8')).toBe('previous reference');
        await atomicWrite(original, 'regenerated reference');
        expect(await locateAsset(root, root, relative, false)).toBe(original);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
  it('accepts relative unicode assets and rejects traversal or absolute paths', () => {
    const root = path.resolve('fixtures');
    expect(safePath(root, 'assets/影片.mp4')).toBe(path.join(root, 'assets', '影片.mp4'));
    for (const name of [
      '../secrets',
      'assets/../../outside',
      'C:\\Windows\\file',
      '/absolute',
      'assets/file:stream',
    ])
      expect(() => safePath(root, name)).toThrow();
  });
  it('atomically replaces existing project data without temporary files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-unit-'));
    const file = path.join(root, 'project.frameforge');
    await atomicWrite(file, 'old');
    await atomicWrite(file, 'new');
    expect(await fs.readFile(file, 'utf8')).toBe('new');
    expect(await fs.readdir(root)).toEqual(['project.frameforge']);
  });
});
