import { _electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testProject } from '../fixtures/project';

export async function launchEditor(options: Parameters<typeof _electron.launch>[0]) {
  const profile = options?.env?.FRAMEFORGE_USER_DATA;
  if (!profile) throw new Error('Desktop tests require an isolated FRAMEFORGE_USER_DATA directory.');
  const recovery = path.join(profile, 'recovery.json');
  if (!(await fs.stat(recovery).catch(() => undefined))) {
    const root = path.resolve(profile, 'test-project');
    const project = testProject();
    for (const asset of project.assets) asset.builtin = false;
    await fs.mkdir(root, { recursive: true });
    await fs.cp('public/test-media', path.join(root, 'test-media'), { recursive: true });
    await fs.writeFile(recovery, JSON.stringify({ project, root }), { flag: 'wx' });
  }
  return _electron.launch(options);
}
