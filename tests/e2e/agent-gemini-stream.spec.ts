import { launchEditor } from './launch-editor';
import { expect } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { AgentSessionService } from '../../desktop/agent-sessions';
import { testWithWorkspace as test } from './workspace-fixture';

test('Gemini streams a separate thought summary and delivers a long reply in sections', async ({
  testWorkspace: root,
}) => {
  const event = (response: ServerResponse, parts: object[], finishReason?: string) =>
    response.write(
      `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason }] })}\n\n`,
    );
  const requests: { url: string; body: any }[] = [];
  let firstSection: ServerResponse | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const bytes of req) chunks.push(bytes);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ url: req.url ?? '', body });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    switch (requests.length) {
      case 1:
        event(res, [{ text: '内部规划', thought: true }, { text: '{"kind":"read"}' }], 'STOP');
        res.end();
        break;
      case 2:
        event(res, [{ text: '先查看当前章节。', thought: true }]);
        firstSection = res;
        break;
      default:
        event(res, [{ text: '## 第二节\n\n第二段正文。' }], 'STOP');
        res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const env = {
    ...process.env,
    FRAMEFORGE_TEST: '1',
    FRAMEFORGE_USER_DATA: root,
    GEMINI_API_KEY: 'fake-test-key',
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  delete (env as NodeJS.ProcessEnv).VITE_DEV_SERVER_URL;
  try {
    const app = await launchEditor({ args: ['.'], env });
    try {
      const page = await app.firstWindow();
      const projectId = await page.evaluate(async (baseUrl) => {
        const { providers } = await window.frameforge!.agentSettings.get();
        await window.frameforge!.agentSettings.save({
          defaultProvider: 'gemini',
          providers: { ...providers, gemini: { ...providers.gemini, baseUrl } },
        });
        return (await window.frameforge!.bootstrap()).project.id;
      }, `http://127.0.0.1:${port}/v1beta`);
      const composer = page.getByLabel('向创作 Agent 发送消息', { exact: true });
      await expect(composer).toBeEnabled();
      await page.getByLabel('对话模型服务商').selectOption('gemini');
      await composer.fill('请分两节详细介绍当前作品的剧情。');
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      const summary = page.locator('.agent-thought-summary');
      await expect(summary).toContainText('先查看当前章节。');
      await expect(page.getByText('内部规划', { exact: true })).toHaveCount(0);
      await expect(page.locator('.agent-message-preview')).toHaveCount(0);
      expect(firstSection).toBeDefined();
      event(firstSection!, [{ text: '\n按章节组织正文。', thought: true }]);
      await expect(summary).toContainText('按章节组织正文。');
      await summary.locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(summary.locator('div')).toBeHidden();
      await page.keyboard.press('Enter');
      await expect(summary.locator('div')).toBeVisible();
      event(firstSection!, [{ text: '## 第一节\n\n第一段正文。' }]);
      await expect(page.locator('.agent-message-preview')).toContainText('第一段正文。');
      await expect(page.locator('.agent-message-preview')).not.toContainText('按章节组织正文。');
      await expect(page.getByRole('button', { name: '停止创作', exact: true })).toBeVisible();
      expect(requests).toHaveLength(2);
      expect(firstSection).toBeDefined();
      event(firstSection!, [{ text: '\n\n第一节结尾。\n\n[继续下一节]\n' }]);
      await expect(page.locator('.agent-message-preview')).toContainText('第一节结尾。');
      await expect(page.locator('.agent-message-preview')).not.toContainText('[继续下一节]');
      event(firstSection!, [], 'STOP');
      firstSection!.end();
      await expect(page.getByRole('heading', { name: '第一节', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '第二节', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '停止创作', exact: true })).toBeHidden();
      await expect(summary).toHaveCount(0);
      expect(requests).toHaveLength(3);
      expect(requests.every(({ url }) => url.endsWith(':streamGenerateContent?alt=sse'))).toBe(
        true,
      );
      expect(JSON.stringify(requests[2].body.contents)).toContain('直接写下一节');
      expect(requests[0].body.generationConfig.thinkingConfig?.includeThoughts).toBeUndefined();
      expect(requests[1].body.generationConfig.thinkingConfig?.includeThoughts).toBe(true);
      expect(requests[2].body.generationConfig.thinkingConfig?.includeThoughts).toBe(true);
      const sessions = new AgentSessionService(root);
      await expect
        .poll(async () => {
          const [chat] = await sessions.list(projectId);
          const saved = chat && (await sessions.load(projectId, chat.id));
          expect(JSON.stringify(saved)).not.toContain('先查看当前章节。');
          expect(JSON.stringify(saved)).not.toContain('按章节组织正文。');
          return saved?.turns.at(-1)?.assistant;
        })
        .toBe('## 第一节\n\n第一段正文。\n\n第一节结尾。\n\n## 第二节\n\n第二段正文。');
    } finally {
      await app.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
