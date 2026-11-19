import { launchEditor } from './launch-editor';
import { expect } from '@playwright/test';
import { testWithWorkspace as test } from './workspace-fixture';
import fs from 'node:fs/promises';
import path from 'node:path';
import { voicePreviewWav } from '../fixtures/voice-preview';
import http from 'node:http';

test('opens application settings from the bottom rail, keeps drafts and returns focus to the editor', async ({
  page,
}) => {
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: '主导航' });
  const settings = navigation.getByRole('button', { name: '设置', exact: true });
  await expect(navigation.getByRole('button', { name: '模型设置', exact: true })).toHaveCount(0);
  await expect(navigation.getByRole('button', { name: '项目设置', exact: true })).toBeVisible();
  const bounds = await settings.boundingBox();
  expect(bounds!.y).toBeGreaterThan(page.viewportSize()!.height / 2);
  await settings.click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('heading', { name: '模型设置', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('接口地址', { exact: true })).toBeHidden();
  await dialog.screenshot({ path: '.local/previews/app-settings.png' });
  await page.screenshot({ path: '.local/previews/app-settings-context.png' });
  await dialog.getByLabel('模型 ID', { exact: true }).fill('custom-model');
  await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeInViewport();
  const rect = await dialog.boundingBox();
  expect(rect!.width).toBeLessThanOrEqual(880);
  expect(rect!.height).toBeLessThanOrEqual(600);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
  await expect(page.locator('.story-node')).toHaveCount(7);
  await settings.click();
  await expect(dialog.getByLabel('模型 ID', { exact: true })).toHaveValue('custom-model');
  await page.getByRole('tab', { name: 'OpenAI', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tab', { name: 'Gemini', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(dialog.getByLabel('模型 ID', { exact: true })).toHaveValue('gemini-4-hydrogen');
  await page.keyboard.press('Control+s');
  await expect(dialog.locator('.agent-save-state')).toHaveText('已保存');
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem('frameforge.agent-settings.v1')!).providers.openai.model,
    ),
  ).toBe('custom-model');
  await page.screenshot({ path: 'test-results/app-settings-compact.png' });
});

test('model settings preserve provider drafts and save metadata without browser key persistence', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型设置', exact: true })).toBeVisible();
  await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('gpt-6.1-sol');
  await page.getByLabel('密钥来源').selectOption('manual');
  await page.getByLabel('API Key', { exact: true }).fill('browser-test-secret');
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password');
  await page.getByRole('tab', { name: /MiniMax/ }).click();
  await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('MiniMax-M3.1-Flash');
  await page.getByLabel('默认模型', { exact: true }).selectOption('minimax');
  await expect(page.getByLabel('图像服务', { exact: true })).toHaveValue('codex');
  await page.getByLabel('图像服务', { exact: true }).selectOption('minimax');
  await page.getByRole('tab', { name: /OpenAI/ }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('browser-test-secret');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('.agent-save-state')).toHaveText('已保存');
  expect(
    await page.evaluate(() => localStorage.getItem('frameforge.agent-settings.v1')),
  ).not.toContain('browser-test-secret');
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('默认模型', { exact: true })).toHaveValue('minimax');
  await expect(page.getByLabel('图像服务', { exact: true })).toHaveValue('minimax');
  await page.getByRole('tab', { name: /OpenAI/ }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();
});

test('desktop detects environment keys, tests all four protocols, encrypts manual keys and restores settings', async ({
  testWorkspace: root,
}) => {
  test.setTimeout(90000);
  const requests: { url: string; authorization?: string; googleKey?: string; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        googleKey: req.headers['x-goog-api-key'] as string | undefined,
        body: JSON.parse(raw),
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          req.url?.endsWith('/responses')
            ? { status: 'completed', output: [] }
            : req.url?.includes(':generateContent')
              ? { candidates: [{ content: { parts: [{ text: 'OK' }] } }] }
              : { choices: [{ message: { content: 'OK' } }] },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    FRAMEFORGE_TEST: '1',
    FRAMEFORGE_USER_DATA: root,
    OPENAI_API_KEY: 'fake-openai',
    GEMINI_API_KEY: 'fake-gemini',
    DEEPSEEK_API_KEY: 'fake-deepseek',
    MINIMAX_API_KEY: 'fake-minimax',
    DOUBAO_TTS_API_KEY: 'fake-doubao-tts',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchEditor({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByText('已检测到', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('fake-openai');
    for (const name of ['OpenAI', 'Gemini', 'DeepSeek', 'MiniMax']) {
      await page.getByRole('tab', { name: new RegExp(name) }).click();
      await page.getByText('高级设置', { exact: true }).click();
      await page.getByLabel('接口地址', { exact: true }).fill(`http://127.0.0.1:${port}`);
      await page.getByRole('button', { name: '测试连接', exact: true }).click();
      await expect(page.locator('.agent-test-result')).toContainText('连接成功');
    }
    expect(requests).toHaveLength(4);
    expect(requests[0]).toMatchObject({
      url: '/responses',
      authorization: 'Bearer fake-openai',
      body: { model: 'gpt-6.1-sol' },
    });
    expect(requests[1]).toMatchObject({
      url: '/models/gemini-4-hydrogen:generateContent',
      googleKey: 'fake-gemini',
    });
    expect(requests[2].body.model).toBe('deepseek-v4-flash');
    expect(requests[3].body.model).toBe('MiniMax-M3.1-Flash');
    await page.getByLabel('密钥来源').selectOption('manual');
    await page.getByLabel('API Key', { exact: true }).fill('manual-private-value');
    await page.getByLabel('默认模型', { exact: true }).selectOption('minimax');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.locator('.agent-save-state')).toHaveText('已保存');
    const stored = await fs.readFile(path.join(root, 'agent-settings.json'), 'utf8');
    expect(stored).not.toContain('manual-private-value');
    expect(stored).not.toContain('fake-minimax');
    await page.reload();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByLabel('默认模型', { exact: true })).toHaveValue('minimax');
    await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute(
      'placeholder',
      '已保存密钥；留空保留',
    );
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.locator('.agent-test-result')).toContainText('连接成功');
    expect(requests.at(-1)?.authorization).toBe('Bearer manual-private-value');
    await page.getByRole('button', { name: '移除已保存密钥', exact: true }).click();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByRole('button', { name: '移除已保存密钥', exact: true })).toHaveCount(0);
    expect(
      JSON.parse(await fs.readFile(path.join(root, 'agent-settings.json'), 'utf8')).encryptedKeys
        .minimax,
    ).toBeUndefined();
    // The desktop service contract is tested separately with a fake HTTP response.
    // Check native audio decoding in the desktop renderer without a paid request.
    await app.evaluate(({ ipcMain }, wavBase64) => {
      ipcMain.removeHandler('agent:connection:test');
      ipcMain.handle('agent:connection:test', (_event, input) => {
        if (input.provider !== 'doubaoTts' || input.audioPrompt !== '你好，帧叙。')
          throw new Error('Unexpected test request');
        return { ok: true, message: '连接成功，已生成测试音频。', audio: { wavBase64 } };
      });
    }, voicePreviewWav());
    await page.getByRole('tab', { name: '豆包 TTS', exact: true }).click();
    await expect(page.getByText('DOUBAO_TTS_API_KEY', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '测试文本', exact: true }).fill('你好，帧叙。');
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.locator('.agent-test-result')).toContainText('已生成测试音频');
    const preview = page.locator('audio[aria-label="豆包测试音频"]');
    await expect
      .poll(() => preview.evaluate((audio: HTMLAudioElement) => audio.duration))
      .toBeCloseTo(0.1);
    await page.getByLabel('密钥来源').selectOption('manual');
    await page.getByLabel('API Key', { exact: true }).fill('fake-manual-speech-key');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.locator('.agent-save-state')).toHaveText('已保存');
    expect(await fs.readFile(path.join(root, 'agent-settings.json'), 'utf8')).not.toContain(
      'fake-manual-speech-key',
    );
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.getByRole('button', { name: '项目设置', exact: true }).click();
    await expect(page.getByLabel('作品名称')).toHaveValue('测试工程');
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
