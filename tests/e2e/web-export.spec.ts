import { launchEditor } from './launch-editor';
import { clickPlayerAction, handlePlayerNotices } from './player-helpers';
import { test, expect, type Page } from './fixtures';
import { unzipSync } from 'fflate';
import { preview } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

async function checkHostedGame(page: Page, root: string, base = '/', choiceQuestion?: string) {
  await handlePlayerNotices(page);
  const server = await preview({
    configFile: false,
    root: path.dirname(root),
    base: './',
    build: { outDir: path.basename(root) },
    preview: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
  });
  const port = (server.httpServer.address() as AddressInfo).port;
  const errors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
  });
  try {
    await page.goto(`http://127.0.0.1:${port}${base}`);
    await expect(page.getByRole('heading', { name: '测试工程', exact: true })).toBeVisible();
    await expect(page.locator('.navigation-rail')).toHaveCount(0);
    await page.getByRole('button', { name: '开始游戏', exact: true }).click();
    await expect(page.locator('.player-shell.standalone')).toBeVisible();
    await expect(page.locator('.player-stage video')).toHaveJSProperty('readyState', 4);
    const video = page.locator('.player-stage video');
    expect(await video.getAttribute('src')).toContain(`${base}game/files/test-media/primary.mp4`);
    // A user gesture is required for audio playback in some browsers.
    const resume = page.getByRole('button', { name: '继续播放', exact: true });
    if (await resume.isVisible()) await resume.click();
    await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
    await clickPlayerAction(page, '存读档');
    await page.getByRole('tab', { name: '存档', exact: true }).click();
    await page.removeLocatorHandler(page.getByRole('alertdialog'));
    await page.getByRole('button', { name: /01 空存档/ }).click();
    await expect(page.getByRole('alertdialog')).toContainText('进度已保存');
    await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click();
    await handlePlayerNotices(page);
    await clickPlayerAction(page, '存读档');
    await page.getByRole('tab', { name: '读档', exact: true }).click();
    await page.getByRole('button', { name: /01 测试开场/ }).click();
    await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
    // Seek the real media to the interaction cue, then follow the real branch.
    await video.evaluate((element: HTMLVideoElement) => {
      element.currentTime = 7;
    });
    await expect(page.getByRole('button', { name: /进入路线 A/ })).toBeVisible({
      timeout: 15000,
    });
    if (choiceQuestion) {
      const group = page.getByRole('group', { name: choiceQuestion });
      await expect(group.getByRole('heading', { name: choiceQuestion })).toBeVisible();
      await expect(group.getByRole('button', { name: /进入路线 A/ })).toBeVisible();
    }
    await page.removeLocatorHandler(page.getByRole('alertdialog'));
    await page.getByRole('button', { name: /进入路线 A/ }).click();
    await expect(page.locator('.player-scene-title h2')).toHaveText('奖励节点');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('.player-change-notice')).toHaveCount(0);
    await handlePlayerNotices(page);
    await page.reload();
    await page.getByRole('button', { name: '继续游戏', exact: true }).click();
    await expect(page.locator('.player-scene-title h2')).toHaveText('奖励节点');
    await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
    await clickPlayerAction(page, '存读档');
    await page.getByRole('tab', { name: '读档', exact: true }).click();
    await expect(page.getByRole('button', { name: /01 测试开场/ })).toBeVisible();
    await page.getByRole('button', { name: /01 测试开场/ }).click();
    await video.evaluate((element: HTMLVideoElement) => {
      element.currentTime = 7;
    });
    await page.getByRole('button', { name: /进入路线 A/ }).click();
    await expect(page.locator('.player-shell')).toHaveAttribute('data-node-id', 'scene_reward');
    await video.evaluate((element: HTMLVideoElement) => {
      element.currentTime = element.duration - 0.1;
    });
    const changes = page.locator('.player-change-notice');
    await expect(changes).toContainText('获得 测试道具 × 1');
    await expect(page.locator('.player-shell')).toHaveAttribute('data-node-id', 'scene_reward');
    await expect(changes.getByRole('button')).toHaveCount(0);
    await expect(changes).toContainText('信任 +15');
    await expect(page.locator('.player-shell')).toHaveAttribute('data-node-id', 'scene_consume');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.player-shell')).toHaveClass(/\bportrait\b/);
    for (const label of ['存读档', '重新开始', '跳至交互'])
      await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '菜单', exact: true }).click();
    const menu = page.getByRole('dialog', { name: '游戏菜单', exact: true });
    await expect(menu.getByRole('button', { name: '存读档', exact: true })).toBeInViewport();
    await expect(menu.getByRole('button', { name: '重新开始', exact: true })).toBeInViewport();
    await expect(menu.getByRole('button', { name: '跳至交互', exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/web-game-mobile.png' });
    expect(errors).toEqual([]);
    expect(failedRequests).toEqual([]);
  } finally {
    await page.close();
    await new Promise<void>((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test('browser downloads a deployable web game with imported media and works under a subdirectory', async ({
  page,
  browser,
  testWorkspace: root,
}) => {
  test.setTimeout(90000);
  await page.goto('/');
  // Include a custom local image, rather than testing only built-in demo resources.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入视频 / 图片' }).click();
  await (
    await chooser
  ).setFiles({
    name: '封面 #1.png',
    mimeType: 'image/png',
    buffer: await fs.readFile('public/app-icon.png'),
  });
  await expect(page.locator('.asset-card')).toHaveCount(4);
  const question = '请选择测试路线。';
  await page.locator('.inspector-tabs').getByRole('button', { name: /^选项/ }).click();
  await page.getByRole('textbox', { name: '问题（可选）', exact: true }).fill(question);
  await page.getByRole('button', { name: '导出作品', exact: true }).click();
  await expect(page.getByLabel('导出格式')).toHaveValue('web');
  const downloaded = page.waitForEvent('download', { timeout: 15000 });
  await page.getByRole('dialog').getByRole('button', { name: '导出作品', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('测试工程-web.zip');
  await expect(page.getByRole('heading', { name: '导出完成' })).toBeVisible();
  const files = unzipSync(new Uint8Array(await fs.readFile((await download.path())!)));
  const project = JSON.parse(new TextDecoder().decode(files['game/project.json']));
  expect(files['index.html']).toBeTruthy();
  expect(files[`game/files/${project.assets[3].path}`].length).toBeGreaterThan(100);
  expect(files['game/files/test-media/primary.mp4']).toBeTruthy();
  expect(files['部署说明.txt']).toBeTruthy();
  for (const [relative, bytes] of Object.entries(files)) {
    const destination = path.join(root, 'games', 'story', relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);
  }
  const context = await browser.newContext();
  try {
    await checkHostedGame(await context.newPage(), root, '/games/story/', question);
  } finally {
    await context.close();
  }
});

test('desktop exports a static website that runs without the editor', async ({
  browser,
  testWorkspace: root,
}) => {
  test.setTimeout(90000);
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    FRAMEFORGE_TEST: '1',
    FRAMEFORGE_USER_DATA: path.join(root, 'user-data'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchEditor({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await handlePlayerNotices(page);
    const question = '请选择测试路线。';
    await page.locator('.inspector-tabs').getByRole('button', { name: /^选项/ }).click();
    await page.getByRole('textbox', { name: '问题（可选）', exact: true }).fill(question);
    await page.getByRole('button', { name: '导出作品', exact: true }).click();
    await page.getByLabel('导出格式').selectOption('web');
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, root);
    await page.getByRole('dialog').getByRole('button', { name: '导出作品', exact: true }).click();
    await expect(page.getByRole('heading', { name: '导出完成' })).toBeVisible();
    const exported = (await fs.readdir(root)).find((name) => name.includes('-web-'))!;
    expect(exported).toBeTruthy();
    const output = path.join(root, exported);
    expect((await fs.readdir(output)).some((name) => name.endsWith('.exe'))).toBe(false);
    const context = await browser.newContext();
    try {
      await checkHostedGame(await context.newPage(), output, '/', question);
    } finally {
      await context.close();
    }
  } finally {
    await app.close();
  }
});
