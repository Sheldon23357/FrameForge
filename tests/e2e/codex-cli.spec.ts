import { launchEditor } from './launch-editor';
import { expect } from '@playwright/test';
import { testWithWorkspace as test } from './workspace-fixture';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testProject } from '../fixtures/project';
import { voicePreviewWav } from '../fixtures/voice-preview';

test('browser settings explain desktop CLI access and preserve the new provider', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: 'Codex CLI', exact: true }).click();
  await expect(page.getByLabel('密钥来源')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toHaveValue('default');
  await expect(page.getByText('模型列表请在桌面版查看。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('CLI 程序路径', { exact: true })).toBeHidden();
  await page.getByText('高级设置', { exact: true }).click();
  await expect(page.getByRole('button', { name: '自动查找', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '浏览选择程序', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '设为默认', exact: true }).click();
  await page.getByLabel('模型 ID', { exact: true }).fill('custom-codex-model');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('.agent-save-state')).toHaveText('已保存');
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Codex CLI', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toHaveValue(
    'custom-codex-model',
  );
  await page.setViewportSize({ width: 1100, height: 720 });
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport();
});

test('desktop rejects sound generation and mixes new Codex BGM with a reused sound effect', async ({
  testWorkspace: root,
}) => {
  const project = testProject();
  const effectPath = 'assets/sound/forest.wav';
  const effect = Buffer.from(voicePreviewWav(0.2), 'base64');
  await fs.mkdir(path.join(root, 'assets', 'sound'), { recursive: true });
  await fs.writeFile(path.join(root, effectPath), effect);
  project.assets.push({
    id: 'asset_primary_effect',
    name: '测试脚步.wav',
    path: effectPath,
    type: 'audio',
    size: effect.length,
    width: 0,
    height: 0,
    durationMs: 200,
    builtin: false,
  });
  const recoveryPath = path.join(root, 'recovery.json');
  await fs.writeFile(recoveryPath, JSON.stringify({ project, root }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FRAMEFORGE_TEST: '1',
    FRAMEFORGE_USER_DATA: root,
    FAKE_CODEX_SCENARIO: 'production-audio',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchEditor({
    args: ['.'],
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.evaluate((projectId) => {
        const input = {
          projectId,
          requestId: crypto.randomUUID(),
          productionAudio: {
            category: 'sound',
            name: '测试脚步',
            prompt: '青石上的脚步声',
            durationMs: 200,
          },
        } as unknown as Parameters<NonNullable<Window['frameforge']>['generateWorldReference']>[0];
        return window.frameforge!.generateWorldReference(input);
      }, project.id),
    ).rejects.toThrow('参考素材的生成参数无效');
    await page.evaluate(async (cliPath) => {
      const settings = await window.frameforge!.agentSettings.get();
      await window.frameforge!.agentSettings.save({
        defaultProvider: 'codex',
        providers: { ...settings.providers, codex: { ...settings.providers.codex, cliPath } },
      });
    }, path.resolve('tests/fixtures/fake-codex-cli.mjs'));
    await page.getByLabel('对话模型服务商').selectOption('codex');
    await page
      .getByLabel('向创作 Agent 发送消息', { exact: true })
      .fill('为当前节点制作悬念 BGM，复用素材库的脚步音效，一起加入时间线');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.locator('.agent-change-status')).toContainText('已提交 4 项编辑');
    const saved = async () =>
      JSON.parse(await fs.readFile(recoveryPath, 'utf8')).project as typeof project;
    await expect
      .poll(async () => (await saved()).scenes[0].timeline?.audioClips)
      .toMatchObject([
        { assetId: 'asset_primary_effect', role: 'effect', durationMs: 200 },
        { role: 'music', durationMs: 8000, loop: true, volume: 0.2, fadeOutMs: 400 },
      ]);
    const mixed = await saved();
    const bgm = mixed.assets.find(
      ({ id }) => id === mixed.scenes[0].timeline?.audioClips[1].assetId,
    )!;
    expect(bgm).toMatchObject({ type: 'audio', durationMs: 2000 });
    expect(bgm.path).toMatch(/^assets\/music\/.*\.wav$/);
    const wav = await fs.readFile(path.join(root, bgm.path));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(40)).toBe(96000);
    expect(wav.subarray(44).some((byte) => byte !== 0)).toBe(true);
    await page.getByRole('button', { name: '撤销本轮', exact: true }).click();
    await expect(page.locator('.agent-change-status')).toContainText('已撤销本轮修改');
    await expect.poll(async () => (await saved()).scenes[0].timeline?.audioClips ?? []).toEqual([]);
    expect((await saved()).assets.some(({ id }) => id === 'asset_primary_effect')).toBe(true);
  } finally {
    await app.close();
  }
});

test('desktop discovers and browses CLI paths, tests a local stub, edits through Agent and undoes once', async ({
  testWorkspace: root,
}) => {
  test.setTimeout(90000);
  // Discovery finds this program in PATH without executing it. Inference uses the stub below.
  const discovered = path.join(root, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await fs.writeFile(discovered, 'discovery-only fixture');
  const fixture = path.resolve('tests/fixtures/fake-codex-cli.mjs');
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`,
      FRAMEFORGE_TEST: '1',
      FRAMEFORGE_USER_DATA: root,
      FAKE_CODEX_SCENARIO: 'tools',
      FAKE_CODEX_LOG: path.join(root, 'rpc.jsonl'),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchEditor({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: 'Codex CLI', exact: true }).click();
    await expect(page.getByLabel('CLI 程序路径', { exact: true })).toBeHidden();
    await page.getByText('高级设置', { exact: true }).click();
    await page.getByRole('button', { name: '自动查找', exact: true }).click();
    await expect(page.getByLabel('CLI 程序路径', { exact: true })).toHaveValue(discovered);
    await expect(page.getByText(/已填入首选路径/)).toBeVisible();
    // Exercise the real preload/IPC picker endpoint while substituting the OS dialog in main.
    await app.evaluate(({ dialog }, program) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [program] });
    }, fixture);
    await page.getByRole('button', { name: '浏览选择程序', exact: true }).click();
    await expect(page.getByLabel('CLI 程序路径', { exact: true })).toHaveValue(fixture);
    // A cancelled picker preserves the current draft.
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });
    await page.getByRole('button', { name: '浏览选择程序', exact: true }).click();
    await expect(page.getByLabel('CLI 程序路径', { exact: true })).toHaveValue(fixture);
    const model = page.getByRole('combobox', { name: '模型', exact: true });
    await expect(model.locator('option')).toHaveText([
      '跟随 Codex 默认设置',
      'Fixture Fast',
      'Fixture Deep',
    ]);
    await model.selectOption('fixture-deep');
    await page.getByRole('button', { name: '设为默认', exact: true }).click();
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.locator('.agent-test-result')).toContainText('连接成功');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.locator('.agent-save-state')).toHaveText('已保存');
    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(model).toHaveValue('fixture-deep');
    await page.getByText('高级设置', { exact: true }).click();
    await expect(page.getByLabel('CLI 程序路径', { exact: true })).toHaveValue(fixture);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect(page.getByLabel('对话模型服务商')).toHaveValue('codex');
    await page.getByLabel('向创作 Agent 发送消息', { exact: true }).fill('修改当前节点标题');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const title = page.locator('.inspector-scene-title h2');
    await expect(title).toHaveText('CLI 第一处修改');
    await expect(page.locator('.agent-change-status')).toContainText('已提交 1 项编辑');
    await page.getByRole('button', { name: '撤销本轮', exact: true }).click();
    await expect(title).not.toHaveText('CLI 第一处修改');
    const sessions = await fs.readdir(path.join(root, 'agent-sessions')).catch(() => []);
    expect(sessions.length).toBeGreaterThan(0);
    expect(await page.locator('body').textContent()).not.toContain('SECRET');
    const calls = (await fs.readFile(path.join(root, 'rpc.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      calls.filter((call) => call.method === 'thread/start').map((call) => call.params.model),
    ).toEqual(['fixture-deep', 'fixture-deep', 'fixture-deep']);
  } finally {
    await app.close();
  }
});
test('desktop generates a setting and its reference, uses it for a Codex storyboard shot and undoes it once', async ({
  testWorkspace: root,
}) => {
  const project = testProject();
  const atmosphereTone = '低饱和钢灰，保留人物自然肤色与实际暖光。';
  project.settings.atmosphereTone = atmosphereTone;
  await fs.writeFile(path.join(root, 'recovery.json'), JSON.stringify({ root, project }));
  const codexHome = path.join(root, 'codex');
  const image = path.join(codexHome, 'generated_images', 'codex-test-thread', 'shot.png');
  await fs.mkdir(path.dirname(image), { recursive: true });
  const rpcLog = path.join(root, 'storyboard-rpc.jsonl');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FRAMEFORGE_TEST: '1',
    FRAMEFORGE_USER_DATA: root,
    CODEX_HOME: codexHome,
    FAKE_CODEX_SCENARIO: 'storyboard',
    FAKE_CODEX_IMAGE: image,
    FAKE_CODEX_LOG: rpcLog,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchEditor({
    args: ['.'],
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  try {
    const base64 = await app.evaluate(({ nativeImage }) =>
      nativeImage
        .createFromBitmap(Buffer.alloc(320 * 180 * 4, 255), { width: 320, height: 180 })
        .toPNG()
        .toString('base64'),
    );
    await fs.writeFile(image, Buffer.from(base64, 'base64'));
    const page = await app.firstWindow();
    await page.evaluate(async (cliPath) => {
      const settings = await window.frameforge!.agentSettings.get();
      await window.frameforge!.agentSettings.save({
        defaultProvider: 'codex',
        providers: { ...settings.providers, codex: { ...settings.providers.codex, cliPath } },
      });
    }, path.resolve('tests/fixtures/fake-codex-cli.mjs'));
    await page.getByLabel('对话模型服务商').selectOption('codex');
    await page
      .getByLabel('向创作 Agent 发送消息', { exact: true })
      .fill('使用 Codex CLI 为当前节点补齐设定，生成设定图和分镜图');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.locator('.agent-change-status')).toContainText('已提交 5 项编辑');
    const saved = async () =>
      JSON.parse(await fs.readFile(path.join(root, 'recovery.json'), 'utf8'));
    await expect
      .poll(async () => (await saved()).project.productionShots?.[0]?.firstFrameAssetId)
      .toMatch(/^asset_/);
    const recovery = await saved();
    const shot = recovery.project.productionShots[0];
    const setting = recovery.project.worldSettings[0];
    const asset = recovery.project.assets.find(
      ({ id }: { id: string }) => id === shot.firstFrameAssetId,
    );
    const reference = recovery.project.assets.find(
      ({ id }: { id: string }) => id === setting.imageAssetId,
    );
    expect(shot).toMatchObject({ label: '开场分镜', nodeId: 'scene_intro' });
    expect(asset).toMatchObject({ type: 'image', width: 320, height: 180 });
    expect(asset.path).toMatch(/^assets\/image\/.*\.png$/);
    expect(await fs.stat(path.join(recovery.root, asset.path))).toMatchObject({ size: asset.size });
    const calls = (await fs.readFile(rpcLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const render = calls.find(
      (call) =>
        call.method === 'turn/start' &&
        call.params.input.some((item: { type: string }) => item.type === 'localImage'),
    );
    expect(render.params.input).toMatchObject([
      { type: 'text', text: expect.stringContaining('低机位近景') },
      { type: 'localImage', path: path.join(recovery.root, reference.path) },
    ]);
    const imagePrompts = calls
      .filter(
        (call) =>
          call.method === 'turn/start' && call.params.input[0].text.includes('\n\n风格补充描述\n'),
      )
      .map((call) => call.params.input[0].text as string);
    expect(imagePrompts).toHaveLength(2);
    for (const prompt of imagePrompts) expect(prompt).toContain(atmosphereTone);
    await page.getByRole('button', { name: '撤销本轮', exact: true }).click();
    await expect(page.locator('.agent-change-status')).toContainText('已撤销本轮修改');
    await expect
      .poll(async () => {
        const { project } = await saved();
        return [
          project.productionShots?.length ?? 0,
          project.worldSettings?.length ?? 0,
          project.assets.some(({ id }: { id: string }) => id === asset.id || id === reference.id),
        ];
      })
      .toEqual([0, 0, false]);
  } finally {
    await app.close();
  }
});
