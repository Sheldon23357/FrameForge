import { seedBrowserProject } from './workspace-fixture';
import { launchEditor } from './launch-editor';
import { test, expect } from './fixtures';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testProject } from '../fixtures/project';
import { defaultAgentSettings } from '../../packages/agent/settings';
import { createWorldSetting } from '../../packages/domain/world-settings';
import { voicePreviewWav } from '../fixtures/voice-preview';

test('chooses local reference files when creating and updating settings', async ({ page }) => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=',
    'base64',
  );
  const wav = Buffer.from(voicePreviewWav(), 'base64');
  const choose = async (name: string, file: { name: string; mimeType: string; buffer: Buffer }) => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name, exact: true }).click();
    const input = await chooser;
    expect(input.isMultiple()).toBe(false);
    await input.setFiles(file);
  };
  await page.goto('/');
  const settings = page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '设定', exact: true });
  await settings.click();
  await page.getByRole('button', { name: '新建角色' }).click();
  const form = page.getByRole('dialog', { name: '新建角色设定' });
  await form.getByLabel('角色名称').fill('本地参考角色');
  await choose('选择图片文件', { name: 'reference.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(form.getByRole('alert')).toContainText('请选择支持的图片文件');
  await choose('选择图片文件', { name: 'reference.png', mimeType: 'image/png', buffer: png });
  await expect(form.getByLabel('参考图（横向 3:2）').locator('option:checked')).toHaveText(
    'reference.png',
  );
  await form.getByRole('button', { name: '保存设定' }).click();
  const detail = page.getByRole('article', { name: '设定详情' });
  const image = detail.getByRole('img', { name: '本地参考角色的参考图' });
  await expect(image).toHaveJSProperty('naturalWidth', 1);
  await choose('选择音频文件', { name: 'voice.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(detail.getByLabel('声音样本')).toHaveAttribute('src', /^blob:/);
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await settings.click();
  await expect(image).toHaveJSProperty('naturalWidth', 1);
  await expect(detail.getByLabel('声音样本')).toHaveAttribute('src', /^blob:/);
  await page.getByRole('button', { name: /^场景/ }).click();
  await page.getByRole('button', { name: '新建场景' }).click();
  const location = page.getByRole('dialog', { name: '新建场景设定' });
  await location.getByLabel('场景名称').fill('本地参考场景');
  await choose('选择音频文件', { name: 'ambience.wav', mimeType: 'audio/wav', buffer: wav });
  await location.getByRole('button', { name: '保存设定' }).click();
  await expect(detail.getByLabel('环境声样本')).toHaveAttribute('loop', '');
  await choose('选择图片文件', { name: 'location.png', mimeType: 'image/png', buffer: png });
  await expect(detail.getByRole('img', { name: '本地参考场景的参考图' })).toHaveJSProperty(
    'naturalWidth',
    1,
  );
});

test('maintains character and location settings with their own reference actions and no node table', async ({
  page,
}) => {
  const project = testProject();
  project.settings.artStyle = { preset: 'threeD', description: '柔和的光照' };
  const reference = {
    id: 'asset_test_reference',
    name: '测试参考图.jpg',
    path: 'test-media/primary.jpg',
    type: 'image' as const,
    width: 640,
    height: 360,
    durationMs: 0,
    size: 0,
    builtin: true,
  };
  project.assets.push(reference);
  await seedBrowserProject(page, project);
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '主导航' });
  const settingsButton = nav.getByRole('button', { name: '设定', exact: true });
  await settingsButton.click();
  await page.getByRole('button', { name: '新建角色' }).click();
  const character = page.getByRole('dialog', { name: '新建角色设定' });
  await character.getByLabel('角色名称').fill('林远');
  await character.getByLabel('角色形象').fill('灰色制服和铜钥匙');
  await character.getByLabel('声音描述').fill('低声，语速慢');
  await character.getByLabel('绘图提示词').fill('突出衣料纹理');
  await character.getByLabel('参考图（横向 3:2）').selectOption(reference.id);
  await character.getByRole('button', { name: '保存设定' }).click();
  const detail = page.getByRole('article', { name: '设定详情' });
  await expect(detail.getByText('低声，语速慢')).toBeVisible();
  const image = detail.getByRole('img', { name: '林远的参考图' });
  await expect(image).toBeVisible();
  const expectLandscapeReference = async () => {
    const box = await image.boundingBox();
    expect(box!.width / box!.height).toBeCloseTo(3 / 2, 2);
  };
  await expectLandscapeReference();
  await expect(detail.getByText('关联剧情节点')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: '生成定妆参考图' })).toBeDisabled();
  await expect(detail.getByRole('button', { name: '创建示例音频' })).toBeDisabled();

  await page.getByRole('button', { name: /^场景/ }).click();
  await page.getByRole('button', { name: '新建场景' }).click();
  const location = page.getByRole('dialog', { name: '新建场景设定' });
  await location.getByLabel('场景名称').fill('废弃站台');
  await location.getByLabel('环境声音').fill('远处的列车与风声');
  await location.getByRole('button', { name: '保存设定' }).click();
  await expect(detail.getByText('远处的列车与风声')).toBeVisible();
  await expect(detail.getByRole('button', { name: '生成场景参考图' })).toBeDisabled();
  await expect(detail.getByRole('button', { name: '生成环境声' })).toBeDisabled();
  const projectSettings = nav.getByRole('button', { name: '项目设置' });
  await projectSettings.click();
  const preset = page.getByRole('combobox', { name: '作品画风', exact: true });
  await expect(preset.locator('optgroup[label="基础画风"]')).toContainText('真人写实');
  await expect(preset.locator('optgroup[label="3D"]')).toContainText('国漫3D高清渲染风');
  await expect(preset).toHaveValue('threeD');
  await expect(page.getByLabel('画风详细描述')).toHaveCount(0);
  await preset.selectOption({ label: '二次元动画' });
  const atmosphereTone = page.getByRole('textbox', { name: '风格补充描述', exact: true });
  await atmosphereTone.fill('钢灰与石墨灰，保持人物肤色自然。');
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await projectSettings.click();
  await expect(preset).toHaveValue('anime');
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('frameforge.project.v1') ?? '{}').settings.artStyle
          .description,
    ),
  ).toBe('柔和的光照');
  await expect(atmosphereTone).toHaveValue('钢灰与石墨灰，保持人物肤色自然。');
  await settingsButton.click();
  await expect(detail.getByRole('heading', { name: '林远' })).toBeVisible();
  const search = page.getByRole('searchbox', { name: '搜索设定' });
  await search.fill('不存在');
  await expect(page.getByText('没有匹配的设定')).toBeVisible();
  await search.fill('铜钥匙');
  await expect(detail.getByRole('heading', { name: '林远' })).toBeVisible();
  await page.setViewportSize({ width: 720, height: 860 });
  await expectLandscapeReference();
  expect(
    await page.locator('.world-settings').evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  await detail.getByRole('button', { name: '删除', exact: true }).click();
  await page
    .getByRole('dialog', { name: '删除设定' })
    .getByRole('button', { name: '删除设定', exact: true })
    .click();
  await expect(detail).toHaveCount(0);
  await search.blur();
  await page.keyboard.press('Control+z');
  await expect(detail.getByRole('heading', { name: '林远' })).toBeVisible();
});

test('desktop copies a manually selected reference into the project', async ({
  testWorkspace: root,
}) => {
  const userData = path.join(root, 'profile');
  const projectRoot = path.join(root, 'project');
  const source = path.join(root, 'reference.wav');
  const audio = Buffer.from(voicePreviewWav(), 'base64');
  const project = testProject();
  const setting = createWorldSetting(project, 'character', { name: '本地配音' });
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(source, audio);
  await fs.writeFile(
    path.join(userData, 'recovery.json'),
    JSON.stringify({ project, root: projectRoot }),
  );
  const env: Record<string, string> = {
    ...process.env,
    FRAMEFORGE_TEST: '1',
    FRAMEFORGE_USER_DATA: userData,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchEditor({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async (_owner, options?: Electron.OpenDialogOptions) => {
        if (
          !options?.filters?.[0].extensions.includes('wav') ||
          options.filters[0].extensions.includes('png') ||
          options.properties?.includes('multiSelections')
        )
          throw new Error('音频选择器筛选错误');
        return { canceled: false, filePaths: [file] };
      };
    }, source);
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '设定', exact: true })
      .click();
    await page.getByRole('button', { name: '选择音频文件', exact: true }).click();
    await expect(page.getByLabel('声音样本')).toHaveAttribute('src', /asset_/);
    await expect
      .poll(async () => {
        const saved = JSON.parse(await fs.readFile(path.join(userData, 'recovery.json'), 'utf8'))
          .project as typeof project;
        const id = saved.worldSettings?.find((entry) => entry.id === setting.id)?.audioAssetId;
        const asset = saved.assets.find((entry) => entry.id === id);
        return asset
          ? (await fs.readFile(path.join(projectRoot, asset.path))).equals(audio)
          : false;
      })
      .toBe(true);
  } finally {
    await app.close();
  }
});

test('desktop queues images across project windows, saves each file to its own project, and isolates WAV playback', async ({
  testWorkspace: root,
}) => {
  const userData = path.join(root, 'profile');
  const codexHome = path.join(root, 'codex');
  const generated = path.join(codexHome, 'generated_images', 'codex-test-thread', 'test.png');
  const projectRoot = path.join(root, 'project');
  const otherRoot = path.join(root, 'other');
  const otherFile = path.join(otherRoot, 'project.frameforge');
  const audioPath = 'assets/existing.wav';
  const audio = Buffer.from(voicePreviewWav(), 'base64');
  await fs.mkdir(path.dirname(generated), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'assets'), { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(path.join(projectRoot, audioPath), audio);
  const project = testProject();
  project.assets.push({
    id: 'asset_existing_voice',
    name: 'existing.wav',
    path: audioPath,
    type: 'audio',
    size: audio.length,
    durationMs: 100,
    width: 0,
    height: 0,
    builtin: false,
  });
  const setting = createWorldSetting(project, 'character', {
    name: '测试角色',
    visual: '蓝色外套',
    sound: '音色清亮',
    audioAssetId: 'asset_existing_voice',
  });
  project.scenes[0].settingIds = [setting.id];
  const other = structuredClone(project);
  other.id = 'project_second_fixture';
  other.title = '第二个工程';
  other.worldSettings![0].name = '另一个角色';
  other.settings.artStyle = { preset: 'realistic', description: '柔和日光' };
  await fs.mkdir(path.join(otherRoot, 'assets'), { recursive: true });
  await fs.writeFile(path.join(otherRoot, audioPath), Buffer.from(voicePreviewWav(0.2), 'base64'));
  await fs.writeFile(otherFile, JSON.stringify(other));
  await fs.writeFile(
    path.join(userData, 'recovery.json'),
    JSON.stringify({ project, root: projectRoot }),
  );
  const settings = defaultAgentSettings();
  settings.providers.codex.cliPath = path.resolve('tests/fixtures/fake-codex-cli.mjs');
  await fs.writeFile(
    path.join(userData, 'agent-settings.json'),
    JSON.stringify({ settings, encryptedKeys: {} }),
  );
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    FRAMEFORGE_TEST: '1',
    FRAMEFORGE_USER_DATA: userData,
    CODEX_HOME: codexHome,
    FAKE_CODEX_SCENARIO: 'image',
    FAKE_CODEX_IMAGE: generated,
    FAKE_CODEX_IMAGE_DELAY_MS: '2200',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchEditor({ args: ['.'], env });
  try {
    const image = await app.evaluate(({ nativeImage }) =>
      nativeImage
        .createFromBitmap(Buffer.alloc(600 * 300 * 4, 255), { width: 600, height: 300 })
        .toPNG()
        .toString('base64'),
    );
    await fs.writeFile(generated, Buffer.from(image, 'base64'));
    const page = await app.firstWindow();
    const settingsPage = page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '设定', exact: true });
    await settingsPage.click();
    const detail = page.getByRole('article', { name: '设定详情' });
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, otherFile);
    const next = app.waitForEvent('window');
    await page.keyboard.press('Control+Shift+o');
    const otherPage = await next;
    await otherPage
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '设定', exact: true })
      .click();
    const otherDetail = otherPage.getByRole('article', { name: '设定详情' });
    await expect(otherDetail.getByRole('heading', { name: '另一个角色' })).toBeVisible();
    await detail.getByRole('button', { name: '生成定妆参考图' }).click();
    const cancel = detail.getByRole('button', { name: '取消测试角色的参考图' });
    await expect(cancel).toHaveAttribute('title', '生成中，点击取消');
    await expect(cancel.locator('.spin')).toBeVisible();
    await expect(page.getByRole('list', { name: '参考素材生成任务' })).toHaveCount(0);
    await otherDetail.getByRole('button', { name: '生成定妆参考图' }).click();
    const cancelOther = otherDetail.getByRole('button', { name: '取消另一个角色的参考图' });
    await expect(cancelOther).toHaveAttribute('title', '排队中，点击取消');
    await expect(cancelOther.locator('.spin')).toBeVisible();
    const preview = detail.getByRole('img', { name: '测试角色的参考图' });
    await expect
      .poll(() =>
        preview.evaluate((element: HTMLImageElement) => [
          element.naturalWidth,
          element.naturalHeight,
        ]),
      )
      .toEqual([600, 400]);
    const player = detail.locator('audio[aria-label="声音样本"]');
    await player.evaluate((element: HTMLAudioElement) => element.play());
    await expect
      .poll(() => player.evaluate((element: HTMLAudioElement) => element.ended))
      .toBe(true);
    const otherPlayer = otherDetail.locator('audio[aria-label="声音样本"]');
    await otherPlayer.evaluate((element: HTMLAudioElement) => element.play());
    await expect
      .poll(() => otherPlayer.evaluate((element: HTMLAudioElement) => element.duration))
      .toBeCloseTo(0.2);
    await expect(otherDetail.getByRole('img', { name: '另一个角色的参考图' })).toBeVisible();
    const savedProject = async () =>
      JSON.parse(
        await fs.readFile(path.join(projectRoot, 'autosave.frameforge'), 'utf8'),
      ) as typeof project;
    await expect
      .poll(async () => (await savedProject()).worldSettings?.[0]?.imageAssetId)
      .toMatch(/^asset_/);
    const saved = await savedProject();
    expect(saved.scenes[0].settingIds).toEqual([setting.id]);
    const asset = saved.assets.find(
      (asset) => asset.id === saved.worldSettings?.[0]?.imageAssetId,
    )!;
    expect(await fs.stat(path.join(projectRoot, asset.path))).toMatchObject({ size: asset.size });
    const otherSaved = async () =>
      JSON.parse(
        await fs.readFile(path.join(otherRoot, 'autosave.frameforge'), 'utf8'),
      ) as typeof project;
    await expect
      .poll(async () => (await otherSaved()).worldSettings?.[0]?.imageAssetId)
      .toBe(asset.id);
    expect(await fs.stat(path.join(otherRoot, asset.path))).toMatchObject({ size: asset.size });
    const replacement = await app.evaluate(({ nativeImage }) =>
      nativeImage
        .createFromBitmap(Buffer.alloc(600 * 300 * 4, 180), { width: 600, height: 300 })
        .toPNG()
        .toString('base64'),
    );
    await fs.writeFile(generated, Buffer.from(replacement, 'base64'));
    await detail.getByRole('button', { name: '生成定妆参考图' }).click();
    await expect
      .poll(async () => (await savedProject()).worldSettings?.[0]?.imageAssetId)
      .not.toBe(asset.id);
    expect((await savedProject()).assets.some(({ id }) => id === asset.id)).toBe(false);
    await expect
      .poll(async () =>
        fs.stat(path.join(projectRoot, asset.path)).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
    expect(await fs.stat(path.join(otherRoot, asset.path))).toMatchObject({ size: asset.size });
    await page.reload();
    await settingsPage.click();
    await expect
      .poll(() => preview.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBe(600);
    await detail.getByRole('button', { name: '生成定妆参考图' }).click();
    await cancel.click();
    await expect(detail.getByRole('button', { name: '生成定妆参考图' })).toBeEnabled();
  } finally {
    await app.close();
  }
});
