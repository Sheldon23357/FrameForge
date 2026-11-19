import { seedBrowserProject } from './workspace-fixture';
import { launchEditor } from './launch-editor';
import { clickPlayerAction, handlePlayerNotices } from './player-helpers';
import { test, expect, type Page } from './fixtures';
import fs from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { preview } from 'vite';
import type { AddressInfo } from 'node:net';
import { testProject } from '../fixtures/project';

function musicWav() {
  const rate = 8000;
  const samples = rate * 3;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(Math.round(Math.sin((i / rate) * 440 * Math.PI * 2) * 500), 44 + i * 2);
  return data;
}
async function seconds(page: Page, label: string, value: string) {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press('Tab');
}
async function addMusic(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^导入(?:视频|图片) \/ 音频$/ }).click();
  await (
    await chooser
  ).setFiles({ name: '测试配乐.wav', mimeType: 'audio/wav', buffer: musicWav() });
  await page.getByRole('button', { name: '添加BGM：测试配乐.wav', exact: true }).click();
}

test('inspector saves timed choices and events in tenths', async ({ page }) => {
  const project = testProject();
  const intro = project.scenes[0];
  intro.trimEndMs = 52000;
  project.assets.find((asset) => asset.id === intro.assetId)!.durationMs = 52000;
  intro.choicesAtMs = 50936;
  intro.events = [
    { id: 'event_time', name: '测试事件', trigger: 'time', atMs: 2036, once: true, effects: [] },
  ];
  await seedBrowserProject(page, project);
  await page.goto('/');
  const inspector = page.locator('.inspector');
  const input = inspector.getByLabel('片段内时间（秒）', { exact: true });
  await inspector.getByRole('button', { name: /^选项/ }).click();
  await expect(input).toHaveValue('50.9');
  await input.fill('50.936');
  await input.press('Enter');
  await expect(input).toHaveValue('50.9');
  await inspector.getByRole('button', { name: /^事件/ }).click();
  await expect(input).toHaveValue('2.0');
  await input.fill('2.056');
  await input.press('Tab');
  await expect(input).toHaveValue('2.1');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const scene = JSON.parse(localStorage.getItem('frameforge.project.v1')!).scenes[0];
        return [scene.choicesAtMs, scene.events[0].atMs];
      }),
    )
    .toEqual([50900, 2100]);
});

test('moves timing controls out of the inspector and edits a placeholder duration in the timeline', async ({
  page,
}) => {
  const project = testProject();
  const intro = project.scenes[0];
  intro.assetId = undefined;
  intro.durationMs = 9000;
  intro.trimStartMs = 1000;
  await seedBrowserProject(page, project);
  await page.goto('/');
  const inspector = page.locator('.inspector');
  for (const label of ['入点（秒）', '出点（秒）', '场景时长（秒）'])
    await expect(inspector.getByLabel(label, { exact: true })).toHaveCount(0);
  await inspector.getByRole('button', { name: '编辑节点时间线', exact: true }).click();
  const duration = page.getByLabel('场景时长（秒）', { exact: true });
  await expect(duration).toHaveValue('8');
  await seconds(page, '场景时长（秒）', '7.5');
  await page.getByRole('button', { name: '应用剪辑', exact: true }).click();
  await inspector.getByRole('button', { name: '编辑节点时间线', exact: true }).click();
  await expect(duration).toHaveValue('7.5');
});

test('double click edits a multi-clip node with BGM, previews cuts, applies once and persists', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.locator('.story-node').filter({ hasText: '测试开场' }).dblclick();
  const dialog = page.getByRole('dialog', { name: '节点时间线 · 测试开场', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('素材出点（秒）', { exact: true })).toHaveValue('9');
  await page.getByRole('button', { name: /添加视频：02_/ }).click();
  await seconds(page, '素材入点（秒）', '1');
  await seconds(page, '素材出点（秒）', '3');
  await page.getByRole('button', { name: '视频片段 1', exact: true }).click();
  await seconds(page, '素材出点（秒）', '2');
  await page.getByRole('button', { name: '将超出时间移至片尾', exact: true }).click();
  await addMusic(page);
  await seconds(page, 'BGM 开始时间（秒）', '0.5');
  await page.getByLabel('循环播放裁剪区', { exact: true }).check();
  await seconds(page, 'BGM 播放时长（秒）', '6');
  await page.getByRole('button', { name: '视频片段 1', exact: true }).click();
  await page.getByRole('button', { name: '播放剪辑预览', exact: true }).click();
  await expect
    .poll(() => page.locator('.timeline-preview-stage video:visible').getAttribute('src'))
    .toContain('encounter.mp4');
  await expect(page.locator('.timeline-preview-stage audio')).toHaveJSProperty('paused', false);
  await page.getByRole('button', { name: '暂停剪辑预览', exact: true }).click();
  await expect(page.locator('.timeline-preview-stage audio')).toHaveJSProperty('paused', true);
  await expect(page.locator('.timeline-filmstrip img')).toHaveCount(16);
  await expect(page.getByLabel('音频波形', { exact: true })).toBeVisible();
  expect(
    await page.locator('.timeline-waveform').evaluate((element: HTMLCanvasElement) =>
      element
        .getContext('2d')!
        .getImageData(0, 0, element.width, element.height)
        .data.some((value, index) => index % 4 === 3 && value > 0),
    ),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/node-timeline.png', fullPage: true });
  await page.getByRole('button', { name: '应用剪辑', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.story-node.selected .duration')).toHaveText('2 段 · 00:04');
  await page.getByRole('button', { name: '撤销（Ctrl Z）', exact: true }).click();
  await expect(page.locator('.story-node.selected .duration')).toHaveText('00:09');
  await page.getByRole('button', { name: '重做（Ctrl Shift Z）', exact: true }).click();
  await expect(page.locator('.story-node.selected .duration')).toHaveText('2 段 · 00:04');
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await page.getByRole('button', { name: '编辑节点时间线', exact: true }).click();
  await expect(page.getByRole('button', { name: 'BGM 片段 1', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 720, height: 780 });
  await expect(page.getByRole('button', { name: '应用剪辑', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'test-results/node-timeline-narrow.png', fullPage: true });
  await page.getByRole('button', { name: '返回蓝图', exact: true }).click();
  expect(errors).toEqual([]);
});

test('timeline playback survives hosted web export with music, pauses at choices and restores the second clip', async ({
  page,
  browser,
  testWorkspace: root,
}) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.getByRole('button', { name: '编辑节点时间线', exact: true }).click();
  await page.getByRole('button', { name: /添加视频：02_/ }).click();
  await seconds(page, '素材入点（秒）', '1');
  await seconds(page, '素材出点（秒）', '5');
  await page.getByRole('button', { name: '视频片段 1', exact: true }).click();
  await seconds(page, '素材出点（秒）', '1');
  await seconds(page, '选择出现时间（秒）', '3.036');
  await addMusic(page);
  await page.getByLabel('循环播放裁剪区', { exact: true }).check();
  await seconds(page, 'BGM 播放时长（秒）', '5');
  await seconds(page, '音频淡入（秒）', '4');
  await seconds(page, '音频淡出（秒）', '0.5');
  await page.getByRole('button', { name: '应用剪辑', exact: true }).click();
  await page.getByRole('button', { name: '导出作品', exact: true }).click();
  await page.getByLabel('导出格式').selectOption('web');
  const download = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: '导出作品', exact: true }).click();
  const files = unzipSync(new Uint8Array(await fs.readFile((await (await download).path())!)));
  const project = JSON.parse(new TextDecoder().decode(files['game/project.json']));
  expect(project.scenes[0].choicesAtMs).toBe(3000);
  expect(project.scenes[0].timeline.videoClips).toHaveLength(2);
  expect(project.scenes[0].timeline.audioClips[0]).toMatchObject({
    fadeInMs: 4000,
    fadeOutMs: 500,
  });
  expect(
    files[`game/files/${project.assets.find((a: { type: string }) => a.type === 'audio').path}`],
  ).toBeTruthy();
  for (const [relative, bytes] of Object.entries(files)) {
    const destination = path.join(root, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);
  }
  const server = await preview({
    configFile: false,
    root: path.dirname(root),
    base: './',
    build: { outDir: path.basename(root) },
    preview: { host: '127.0.0.1', port: 0, open: false },
  });
  const context = await browser.newContext();
  let releaseIncomingVideo!: () => void;
  const incomingVideo = new Promise<void>((resolve) => {
    releaseIncomingVideo = resolve;
  });
  try {
    const game = await context.newPage();
    await game.route('**/encounter.mp4', async (route) => {
      await incomingVideo;
      await route.continue();
    });
    await handlePlayerNotices(game);
    const errors: string[] = [];
    game.on('pageerror', (e) => errors.push(e.message));
    await game.goto(`http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/`);
    await game.getByRole('button', { name: '开始游戏', exact: true }).click();
    await expect(game.locator('.player-stage .timeline-media')).toBeVisible();
    const video = game.locator('.player-stage video:visible');
    const audio = game.locator('.player-stage audio');
    await expect(game.locator('.player-shell')).toHaveAttribute('data-position-ms', '1000');
    await expect(video).toHaveAttribute('src', /forest\.mp4/);
    await expect(video).toHaveJSProperty('paused', true);
    await expect(audio).toHaveJSProperty('paused', true);
    releaseIncomingVideo();
    await expect.poll(() => video.getAttribute('src')).toContain('encounter.mp4');
    await expect(game.locator('.player-stage audio')).toHaveJSProperty('paused', false);
    await expect
      .poll(() => game.locator('.player-stage audio').evaluate((a: HTMLAudioElement) => a.volume))
      .toBeGreaterThan(0);
    expect(
      await game.locator('.player-stage audio').evaluate((a: HTMLAudioElement) => a.volume),
    ).toBeLessThan(0.5);
    await game.getByRole('button', { name: '菜单', exact: true }).click();
    await expect(video).toHaveJSProperty('paused', true);
    await expect(audio).toHaveJSProperty('paused', true);
    await game.keyboard.press('Escape');
    await expect(video).toHaveJSProperty('paused', false);
    await expect(audio).toHaveJSProperty('paused', false);
    await game.keyboard.press('Escape');
    await expect(video).toHaveJSProperty('paused', true);
    await expect(audio).toHaveJSProperty('paused', true);
    await clickPlayerAction(game, '存读档');
    await game.getByRole('tab', { name: '存档', exact: true }).click();
    await game.getByRole('button', { name: /01 空存档/ }).click();
    await game.getByRole('button', { name: '播放', exact: true }).click();
    await expect(game.getByRole('button', { name: /进入路线 A/ })).toBeVisible();
    await expect(game.locator('.player-stage audio')).toHaveJSProperty('paused', true);
    await clickPlayerAction(game, '存读档');
    await game.getByRole('tab', { name: '读档', exact: true }).click();
    await game.getByRole('button', { name: /01 测试开场/ }).click();
    await expect(video).toHaveAttribute('src', /encounter\.mp4/);
    await expect(game.locator('.player-stage audio')).toHaveJSProperty('paused', false);
    expect(errors).toEqual([]);
  } finally {
    releaseIncomingVideo();
    await context.close();
    await server.close();
  }
});

test('a still sequence keeps dialogue continuous across cuts and pauses at choices in web export', async ({
  page,
  browser,
  testWorkspace: root,
}) => {
  const fixture = testProject();
  fixture.assets.push({
    ...fixture.assets[0],
    id: 'forest_still',
    name: '测试静态画面',
    path: 'test-media/primary.jpg',
    thumbnail: undefined,
    type: 'image',
    durationMs: 0,
  });
  fixture.scenes[0].assetId = 'forest_still';
  await seedBrowserProject(page, fixture);
  await page.goto('/');
  await page.getByRole('button', { name: '编辑节点时间线', exact: true }).click();
  await expect(page.locator('.timeline-preview-stage .timeline-still')).toBeVisible();
  await seconds(page, '选择出现时间（秒）', '2.6');
  await seconds(page, '画面时长（秒）', '3');
  const imageChooser = page.waitForEvent('filechooser');
  await expect(page.getByRole('button', { name: '导入并排列图片', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '导入图片 / 音频', exact: true }).click();
  await (
    await imageChooser
  ).setFiles([
    {
      name: 'shot-10.jpg',
      mimeType: 'image/jpeg',
      buffer: await fs.readFile('public/test-media/tertiary.jpg'),
    },
    {
      name: 'shot-2.jpg',
      mimeType: 'image/jpeg',
      buffer: await fs.readFile('public/test-media/secondary.jpg'),
    },
  ]);
  const second = page.getByRole('button', { name: '图片 2：shot-2.jpg', exact: true });
  const third = page.getByRole('button', { name: '图片 3：shot-10.jpg', exact: true });
  await expect(second).toHaveCount(0);
  await expect(third).toHaveCount(0);
  await page.getByRole('checkbox', { name: '选择图片：shot-10.jpg', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择图片：shot-2.jpg', exact: true }).check();
  await page.getByRole('button', { name: '排入所选图片（2）', exact: true }).click();
  await expect(second).toBeVisible();
  await expect(third).toBeVisible();
  await third.dragTo(second);
  const incoming = page.getByRole('button', { name: '图片 2：shot-10.jpg', exact: true });
  await incoming.click();
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole('combobox', { name: '进入图片时', exact: true }).selectOption('350');
  await seconds(page, '图片时长（秒）', '2');
  await expect(incoming).toContainText('2.00s');
  const stillEdge = (await incoming.getByTitle('拖动调整图片时长').boundingBox())!;
  const stillClip = (await incoming.boundingBox())!;
  const edgeX = stillEdge.x + stillEdge.width / 2;
  const edgeY = stillEdge.y + stillEdge.height / 2;
  await page.mouse.move(edgeX, edgeY);
  await page.mouse.down();
  await page.mouse.move(edgeX - stillClip.width / 4, edgeY, { steps: 8 });
  await page.mouse.up();
  await expect(incoming).toContainText('1.50s');
  await seconds(page, '图片时长（秒）', '3');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('button', { name: '图片 1：测试静态画面', exact: true }).click();
  await addMusic(page);
  await page.getByRole('combobox', { name: '音频用途', exact: true }).selectOption('dialogue');
  await page.getByRole('button', { name: '对齐画面至配音结束', exact: true }).click();
  await expect(page.getByText('选项会在配音结束前出现。', { exact: false })).toBeVisible();
  await expect(page.getByLabel('图片时长（秒）', { exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: '播放剪辑预览', exact: true }).click();
  await expect(page.locator('.timeline-preview-stage audio')).toHaveJSProperty('paused', false);
  await page.getByRole('button', { name: '应用剪辑', exact: true }).click();
  await page.getByRole('button', { name: '导出作品', exact: true }).click();
  await page.getByLabel('导出格式').selectOption('web');
  const download = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: '导出作品', exact: true }).click();
  const files = unzipSync(new Uint8Array(await fs.readFile((await (await download).path())!)));
  const project = JSON.parse(new TextDecoder().decode(files['game/project.json']));
  expect(project.scenes[0]).toMatchObject({
    assetId: 'forest_still',
    durationMs: 3000,
    timeline: {
      stillClips: [
        { assetId: 'forest_still', durationMs: 1000 },
        { durationMs: 1000, dissolveMs: 350 },
        { durationMs: 1000 },
      ],
      videoClips: [],
      audioClips: [{ role: 'dialogue' }],
    },
  });
  expect(files['game/files/test-media/primary.jpg']).toBeTruthy();
  for (const clip of project.scenes[0].timeline.stillClips) {
    const asset = project.assets.find((entry: { id: string }) => entry.id === clip.assetId);
    expect(files[`game/files/${asset.path}`]).toBeTruthy();
  }
  for (const [relative, bytes] of Object.entries(files)) {
    const destination = path.join(root, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);
  }
  const server = await preview({
    configFile: false,
    root: path.dirname(root),
    base: './',
    build: { outDir: path.basename(root) },
    preview: { host: '127.0.0.1', port: 0, open: false },
  });
  const context = await browser.newContext();
  try {
    const game = await context.newPage();
    await handlePlayerNotices(game);
    await game.goto(`http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/`);
    await game.getByRole('button', { name: '开始游戏', exact: true }).click();
    const still = game.locator('.player-stage .timeline-still[data-active]');
    const audio = game.locator('.player-stage audio');
    await expect(still).toBeVisible();
    await expect
      .poll(() => still.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await expect(game.locator('.player-stage video')).toHaveCount(0);
    await expect(audio).toHaveJSProperty('paused', false);
    await audio.evaluate((element) => {
      element.dataset.continuousAudio = 'yes';
    });
    await expect(still).not.toHaveAttribute('src', /forest\.jpg/);
    await expect(audio).toHaveAttribute('data-continuous-audio', 'yes');
    await expect(audio).toHaveJSProperty('paused', false);
    await expect(game.getByRole('button', { name: /进入路线 A/ })).toBeVisible();
    await expect(audio).toHaveJSProperty('paused', true);
  } finally {
    await context.close();
    await server.close();
  }
});

test('discarding a timeline draft leaves the node unchanged', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '编辑节点时间线', exact: true }).click();
  await page.getByRole('button', { name: /添加视频：02_/ }).click();
  await page.getByRole('button', { name: '返回蓝图', exact: true }).click();
  await page.getByRole('button', { name: '放弃剪辑', exact: true }).click();
  await expect(page.locator('.story-node.selected .duration')).toHaveText('00:09');
  await expect(page.locator('.inspector-preview img')).toHaveAttribute('src', /forest\.jpg/);
});

test('professional timeline supports pointer trimming, splitting, audio positioning and height preferences', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '编辑节点时间线', exact: true }).click();
  const row = page.locator('.timeline-video-track');
  const handle = page.getByLabel('裁剪视频片段 1 出点', { exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await page.getByLabel('素材出点（秒）', { exact: true }).inputValue()))
    .toBeLessThan(9);
  await page.getByRole('button', { name: '撤销剪辑', exact: true }).click();
  await expect(page.getByLabel('素材出点（秒）', { exact: true })).toHaveValue('9');
  const head = page.getByRole('slider', { name: '时间线播放头', exact: true });
  const bounds = (await row.boundingBox())!;
  await page.locator('.timeline-ruler > div').click({ position: { x: bounds.width / 3, y: 25 } });
  await expect
    .poll(async () => Number(await head.getAttribute('aria-valuenow')))
    .toBeGreaterThan(2000);
  await page.getByRole('button', { name: '分割片段（B）', exact: true }).click();
  await expect(page.getByRole('button', { name: '视频片段 2', exact: true })).toBeVisible();
  await expect(page.locator('.timeline-footer')).toContainText('00:00:09.000');
  await addMusic(page);
  const music = page.getByRole('button', { name: 'BGM 片段 1', exact: true });
  const musicBox = (await music.boundingBox())!;
  await page.mouse.move(musicBox.x + 40, musicBox.y + 35);
  await page.mouse.down();
  await page.mouse.move(musicBox.x + 160, musicBox.y + 35, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () =>
      Number(await page.getByLabel('BGM 开始时间（秒）', { exact: true }).inputValue()),
    )
    .toBeGreaterThan(0.5);
  await page
    .getByRole('button', { name: '视频片段 1', exact: true })
    .dragTo(page.getByRole('button', { name: '视频片段 2', exact: true }));
  await expect(page.getByLabel('素材入点（秒）', { exact: true })).toHaveValue('0');
  const resize = page.getByRole('separator', { name: '调整时间线高度', exact: true });
  const before = Number(await resize.getAttribute('aria-valuenow'));
  await resize.focus();
  await page.keyboard.press('ArrowUp');
  await expect(resize).toHaveAttribute('aria-valuenow', String(before + 20));
  await page.getByRole('button', { name: '应用剪辑', exact: true }).click();
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await page.getByRole('button', { name: '编辑节点时间线', exact: true }).click();
  await expect(
    page.getByRole('separator', { name: '调整时间线高度', exact: true }),
  ).toHaveAttribute('aria-valuenow', String(before + 20));
  await expect(page.locator('.timeline-tracks')).toHaveCSS(
    'width',
    `${(await page.locator('.timeline-tracks-scroll').boundingBox())!.width - 4}px`,
  );
  await page.screenshot({ path: '.local/previews/timeline-professional.png', fullPage: true });
});

test('desktop timeline imports local BGM and applies it to the real player', async ({
  testWorkspace: root,
}) => {
  test.setTimeout(60000);
  const music = path.join(root, '桌面配乐.wav');
  await fs.writeFile(music, musicWav());
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.FRAMEFORGE_USER_DATA = path.join(root, 'user-data');
  env.FRAMEFORGE_TEST = '1';
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchEditor({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await handlePlayerNotices(page);
    await page.getByRole('button', { name: '编辑节点时间线', exact: true }).click();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, music);
    await page.getByRole('button', { name: '导入视频 / 音频', exact: true }).click();
    await page.getByRole('button', { name: '添加BGM：桌面配乐.wav', exact: true }).click();
    const mediaAccess = await page
      .locator('.timeline-media audio')
      .evaluate(async (element: HTMLAudioElement) => {
        try {
          const response = await fetch(element.src);
          return {
            ok: response.ok,
            status: response.status,
            length: (await response.arrayBuffer()).byteLength,
          };
        } catch (error) {
          return { error: String(error) };
        }
      });
    expect(mediaAccess).toMatchObject({ ok: true });
    await expect(page.getByLabel('音频波形', { exact: true })).toBeVisible();
    await expect(page.locator('.timeline-filmstrip img')).toHaveCount(8);
    await page.getByRole('button', { name: '应用剪辑', exact: true }).click();
    await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
    await expect(page.locator('.player-stage .timeline-media')).toBeVisible();
    await expect(page.locator('.player-stage audio')).toHaveJSProperty('readyState', 4);
    const resume = page.getByRole('button', { name: '继续播放', exact: true });
    if (await resume.isVisible()) await resume.click();
    await expect(page.locator('.player-stage audio')).toHaveJSProperty('paused', false);
    await page.keyboard.press('Escape');
    await expect(page.locator('.player-stage audio')).toHaveJSProperty('paused', true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.player-stage audio')).toHaveJSProperty('paused', false);
  } finally {
    await app.close();
  }
});
