import { expect } from '@playwright/test';
import { testWithWorkspace as test } from './workspace-fixture';
import { testProject } from '../fixtures/project';
import { preview } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

function messageProject() {
  const project = testProject();
  project.assets.forEach((asset) => {
    asset.type = 'image';
    asset.path = asset.thumbnail!;
    asset.durationMs = 0;
  });
  const intro = project.scenes[0];
  intro.choicesAtMs = 0;
  const choices = [
    {
      ...intro.choices[0],
      label: '核对时间',
      targetId: 'scene_alternate',
      effects: [
        {
          kind: 'showMessage',
          title: '你的观察',
          text: '先确认时间，再比较证词。\n这是一条独立的剧情反馈。',
        },
      ] as const,
    },
  ];
  const next = project.scenes.find((scene) => scene.id === 'scene_alternate')!;
  next.choices = [];
  next.choicesAtMs = null;
  next.durationMs = 400;
  next.nextId = 'scene_neutral';
  return { ...project, scenes: [{ ...intro, choices }, ...project.scenes.slice(1)] };
}

test('migrates old choice feedback to an editable story node and plays it inline', async ({
  page,
}) => {
  const project = messageProject();
  await page.addInitScript(
    (p) => localStorage.setItem('frameforge.project.v1', JSON.stringify(p)),
    project,
  );
  await page.goto('/');
  await expect(page.locator('.story-node').getByText('你的观察', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
  await page.getByRole('button', { name: /核对时间/ }).click();
  await expect(page.locator('.player-storyboard')).toContainText('先确认时间，再比较证词。');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.locator('.player-ending')).toBeVisible({ timeout: 10000 });
});

test('the standalone web player migrates and plays legacy choice feedback inline', async ({
  page,
  testWorkspace: root,
}) => {
  const project = messageProject();
  await fs.cp('public/web-player', root, { recursive: true });
  await fs.mkdir(path.join(root, 'game', 'files'), { recursive: true });
  await fs.cp('public/demo', path.join(root, 'game', 'files', 'demo'), { recursive: true });
  await fs.writeFile(path.join(root, 'game', 'project.json'), JSON.stringify(project));
  const server = await preview({
    configFile: false,
    root: path.dirname(root),
    base: './',
    build: { outDir: path.basename(root) },
    preview: { host: '127.0.0.1', port: 0, open: false },
  });
  try {
    const port = (server.httpServer.address() as AddressInfo).port;
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole('button', { name: '开始游戏', exact: true }).click();
    await page.getByRole('button', { name: /核对时间/ }).click();
    await expect(page.locator('.player-storyboard')).toContainText('先确认时间，再比较证词。');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('.player-ending')).toBeVisible({ timeout: 10000 });
  } finally {
    await page.close();
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  }
});
