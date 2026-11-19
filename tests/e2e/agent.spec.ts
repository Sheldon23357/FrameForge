import { launchEditor } from './launch-editor';
import { expect } from '@playwright/test';
import { testWithWorkspace as test } from './workspace-fixture';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

test('switching sidebar tabs keeps a single copy of the active page', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '主导航' });
  const world = page.locator('.main-workspace > .world-settings');
  const agent = page.getByRole('complementary', { name: '创作 Agent 对话' });
  const composer = agent.getByRole('textbox', { name: '向创作 Agent 发送消息' });
  await composer.fill('待发送的创作指令');
  const agentElement = await agent.elementHandle();
  await expect(nav.getByRole('button', { name: '创作 Agent', exact: true })).toHaveCount(0);
  for (const label of ['画布', '剧本', '参数', '项目设置']) {
    await nav.getByRole('button', { name: '设定', exact: true }).click();
    await expect(world).toHaveCount(1);
    await expect(world.getByRole('heading', { name: '设定', exact: true })).toBeVisible();
    await expect(agent).toBeVisible();
    await nav.getByRole('button', { name: label, exact: true }).click();
    await expect(world).toHaveCount(0);
    await expect(agent).toBeVisible();
    await expect(composer).toHaveValue('待发送的创作指令');
  }
  expect(await agentElement!.evaluate((element) => element.isConnected)).toBe(true);
});

test('collapses Agent across tabs and restores its draft and preferred width', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '主导航' });
  const agent = page.getByRole('complementary', { name: '创作 Agent 对话' });
  const collapse = agent.getByRole('button', { name: '折叠创作 Agent' });
  const expand = nav.getByRole('button', { name: '展开创作 Agent' });
  const composer = agent.getByRole('textbox', { name: '向创作 Agent 发送消息' });
  const agentResize = page.getByRole('separator', { name: '调整 Agent 面板宽度' });
  const libraryResize = page.getByRole('separator', { name: '调整创作资源面板宽度' });
  const canvas = page.locator('.main-workspace');
  await composer.fill('保留这条草稿');
  await agentResize.press('ArrowRight');
  await expect(agentResize).toHaveAttribute('aria-valuenow', '396');
  const canvasWidth = (await canvas.boundingBox())!.width;
  await collapse.press('Enter');
  await expect(expand).toBeFocused();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(agent).toBeHidden();
  await expect(agentResize).toHaveCount(0);
  await expect(libraryResize).toBeVisible();
  expect((await canvas.boundingBox())!.width).toBe(canvasWidth + 396);

  const script = nav.getByRole('button', { name: '剧本', exact: true });
  await script.click();
  await expect(expand).toBeVisible();
  await expand.press('Space');
  await expect(collapse).toBeFocused();
  await expect(script).toHaveAttribute('aria-current', 'page');
  await expect(composer).toHaveValue('保留这条草稿');
  await expect(agentResize).toHaveAttribute('aria-valuenow', '396');

  await collapse.click();
  await page.reload();
  await expect(expand).toBeVisible();
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(libraryResize).toBeInViewport();
  await expect(page.locator('.inspector')).toBeInViewport();
  await page.locator('.workspace-topbar').getByRole('button', { name: '折叠创作资源' }).click();
  await expect(libraryResize).toHaveCount(0);
  await expect(expand).toBeVisible();
  await expand.click();
  await expect(page.getByRole('button', { name: '展开创作资源' })).toBeVisible();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(agentResize).toHaveAttribute('aria-valuenow', '396');
});

test('keeps Agent, resources and inspector independently resizable on the canvas', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.story-node')).toHaveCount(7);
  const libraryResize = page.getByRole('separator', { name: '调整创作资源面板宽度' });
  const libraryWidth = Number(await libraryResize.getAttribute('aria-valuenow'));
  await libraryResize.press('ArrowRight');
  await expect(libraryResize).toHaveAttribute('aria-valuenow', String(libraryWidth + 16));
  const left = page.getByRole('separator', { name: '调整 Agent 面板宽度' });
  await expect(page.getByRole('heading', { name: '创作 Agent', exact: true })).toBeVisible();
  await expect(page.locator('.story-node')).toHaveCount(7);
  await expect(page.locator('.inspector')).toBeVisible();
  await page.locator('.agent-context-details > summary').click();
  await expect(page.locator('.agent-context-content')).toContainText('测试开场');
  await page.getByRole('button', { name: '固定选中节点', exact: true }).click();
  await expect(page.locator('.agent-context-chips.pinned')).toContainText('测试开场');
  const context = page.getByRole('dialog', { name: '上下文与引用', exact: true });
  await expect(context.locator('textarea')).toHaveCount(0);
  await page.getByRole('tab', { name: /能力/ }).click();
  await context.getByText('剧情大纲', { exact: true }).click();
  await expect(context.getByText('读取剧情大纲', { exact: true })).toBeVisible();
  await context.getByText('角色与场景设定', { exact: true }).click();
  await expect(context.getByText('维护角色与场景设定', { exact: true })).toBeVisible();
  await expect(context.getByText('生成设定参考素材', { exact: true })).toHaveCount(0);
  await context.getByText('剧情选项与事件', { exact: true }).click();
  await expect(context.getByText('编辑剧情选项', { exact: true })).toBeVisible();
  await context.getByText('时间线与音轨', { exact: true }).click();
  await expect(context.getByText('编辑节点时间线', { exact: true })).toBeVisible();
  await context.getByText('草稿续跑', { exact: true }).click();
  await expect(context.getByText('设定本轮创作范围', { exact: true })).toBeVisible();
  await expect(context.getByText('编辑剧情节点', { exact: true })).toBeHidden();
  await context.getByText('剧情与章节', { exact: true }).click();
  await expect(context.getByText('编辑剧情节点', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(context).toHaveCount(0);
  await page.locator('.agent-context-details > summary').click();
  await expect(page.getByRole('tab', { name: /引用/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: '关闭上下文', exact: true }).click();
  const box = (await left.boundingBox())!;
  const before = Number(await left.getAttribute('aria-valuenow'));
  await page.mouse.move(box.x + box.width / 2, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 75, box.y + 150, { steps: 5 });
  await page.mouse.up();
  await expect(left).toHaveAttribute('aria-valuenow', String(before + 75));
  const right = page.getByRole('separator', { name: '调整检查器宽度' });
  await right.focus();
  await page.keyboard.press('ArrowLeft');
  const rightValue = await right.getAttribute('aria-valuenow');
  const library = page.getByRole('heading', { name: '创作资源', exact: true });
  const search = page.getByRole('textbox', { name: '搜索创作资源' });
  await search.fill('测试');
  const canvas = page.locator('.main-workspace');
  const toolbar = page.locator('.workspace-topbar');
  const expandedWidth = (await canvas.boundingBox())!.width;
  await toolbar.getByRole('button', { name: '折叠创作资源' }).press('Enter');
  const expand = page.getByRole('button', { name: '展开创作资源' });
  await expect(expand).toBeFocused();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(library).toBeHidden();
  expect((await canvas.boundingBox())!.width).toBe(expandedWidth + libraryWidth + 16);
  await expand.press('Space');
  await expect(search).toHaveValue('测试');
  await toolbar.getByRole('button', { name: '折叠创作资源' }).click();
  await page.getByRole('button', { name: '剧本', exact: true }).click();
  await expect(expand).toHaveCount(0);
  await page.getByRole('button', { name: '画布', exact: true }).click();
  await expect(expand).toBeVisible();
  await page.reload();
  await expect(expand).toBeVisible();
  await expect(left).toHaveAttribute('aria-valuenow', String(before + 75));
  await expect(right).toHaveAttribute('aria-valuenow', rightValue!);
  await expand.click();
  await expect(libraryResize).toHaveAttribute('aria-valuenow', String(libraryWidth + 16));
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThanOrEqual(280);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(library).toBeInViewport();
  await expect(libraryResize).toHaveCount(0);
  await expect(left).toBeInViewport();
  await expect(page.locator('.inspector')).toBeInViewport();
  await left.press('Home');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(left).toHaveAttribute('aria-valuenow', '380');
});

test('collapses both panel headers independently and restores the canvas layout and panel widths', async ({
  page,
}) => {
  await page.goto('/');
  const library = page.getByRole('complementary', { name: '创作资源', exact: true });
  const inspector = page.getByRole('complementary', { name: '节点检查器', exact: true });
  const toolbar = page.locator('.workspace-topbar');
  const canvas = page.locator('.main-workspace');
  const libraryResize = page.getByRole('separator', { name: '调整创作资源面板宽度' });
  const inspectorResize = page.getByRole('separator', { name: '调整检查器宽度' });
  const expandLibrary = toolbar.getByRole('button', { name: '展开创作资源' });
  const expandInspector = toolbar.getByRole('button', { name: '展开节点检查器' });
  const width = async () => (await canvas.boundingBox())!.width;

  await library.getByRole('textbox', { name: '搜索创作资源' }).fill('测试');
  await inspector.getByRole('button', { name: '节点内容', exact: true }).click();
  await inspectorResize.press('ArrowLeft');
  const preferredInspector = await inspectorResize.getAttribute('aria-valuenow');
  const libraryWidth = Number(await libraryResize.getAttribute('aria-valuenow'));
  const expandedWidth = await width();

  await library.getByRole('button', { name: '折叠创作资源' }).click();
  await expect(expandLibrary).toBeFocused();
  await expect(library).toBeHidden();
  await expect(inspector).toBeVisible();
  await expect(libraryResize).toHaveCount(0);
  await expect.poll(width).toBe(expandedWidth + libraryWidth);

  await inspector.getByRole('button', { name: '折叠节点检查器' }).press('Enter');
  await expect(expandInspector).toBeFocused();
  await expect(inspector).toBeHidden();
  await expect(inspectorResize).toHaveCount(0);
  await expect.poll(width).toBe(expandedWidth + libraryWidth + Number(preferredInspector));
  await expect(page.getByRole('complementary', { name: '创作 Agent 对话' })).toBeVisible();

  await expandInspector.press('Space');
  await expect(inspector.getByLabel('节点内容')).toBeVisible();
  await expect(inspectorResize).toHaveAttribute('aria-valuenow', preferredInspector!);
  await expect(library).toBeHidden();
  await expandLibrary.click();
  await expect(library.getByRole('textbox', { name: '搜索创作资源' })).toHaveValue('测试');
  await expect.poll(width).toBe(expandedWidth);

  await page.setViewportSize({ width: 900, height: 800 });
  await expect(library).toBeInViewport();
  await expect(inspector).toBeInViewport();
  await toolbar.getByRole('button', { name: '折叠创作资源' }).click();
  await toolbar.getByRole('button', { name: '折叠节点检查器' }).click();
  await expect(expandLibrary).toBeInViewport();
  await expect(expandInspector).toBeInViewport();
  await page.reload();
  await expect(expandLibrary).toHaveAttribute('aria-expanded', 'false');
  await expect(expandInspector).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expandInspector.click();
  await expect(inspectorResize).toHaveAttribute('aria-valuenow', preferredInspector!);
  await expect(library).toBeHidden();
});

test('desktop Agent streams blueprint edits and undoes the whole turn', async ({
  testWorkspace,
}) => {
  await testDesktopAgent(testWorkspace, true);
});

test('desktop Agent creates a gated branch, follows up, undoes, stops and rejects conflicting edits', async ({
  testWorkspace,
}) => {
  await testDesktopAgent(testWorkspace, false);
});

async function testDesktopAgent(root: string, blueprintLive: boolean) {
  test.setTimeout(180000);
  const bodies: any[] = [];
  let held: http.ServerResponse | undefined;
  const releaseHeld = () => {
    held?.destroy();
    held = undefined;
  };
  const answer = (
    res: http.ServerResponse,
    content: string | null,
    calls: any[] = [],
    reason = calls.length ? 'tool_calls' : 'stop',
  ) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) },
            finish_reason: reason,
          },
        ],
      }),
    );
  };
  const call = (name: string, args: unknown, id = name) => ({
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });
  let consequenceNodeId: string;
  let consequenceEventId: string;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (data) => {
      raw += data;
    });
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (body.messages[0]?.content.startsWith('根据本轮请求的完整语义')) {
        const { request } = JSON.parse(body.messages[1].content) as { request: string };
        const plan = request.startsWith('继续')
          ? { kind: 'resume' }
          : request.includes('现在制作第一章的蓝图')
            ? { kind: 'execute', blueprint: { build: true, ordinal: 1 } }
            : { kind: 'execute' };
        answer(res, JSON.stringify(plan));
        return;
      }
      bodies.push(body);
      const progress =
        body.messages
          .filter((m: any) => m.role === 'user' && m.content.includes('任务进度（参考数据）'))
          .at(-1)?.content ?? '';
      const user = progress.split('\n\n任务进度（参考数据）')[0];
      const results = body.messages
        .filter((m: any) => m.role === 'tool' && m.tool_call_id !== 'set_task_scope')
        .map((m: any) => ({ ...m, value: JSON.parse(m.content) }));
      const opening = body.tools?.some((tool: any) => tool.function.name === 'set_task_scope');
      if (user.includes('创建钥匙分支')) {
        if (!results.length)
          answer(res, null, [
            call(
              'edit_game_data',
              { kind: 'item', name: '铜钥匙', description: '打开暗门', initial: 1 },
              'key',
            ),
            call(
              'edit_scene',
              {
                action: 'create',
                args: {
                  kind: 'video',
                  title: '门后的秘密',
                  notes: '主角进门，在桌角找到并展开信件。',
                  storyboardPages: [{ text: '你发现了隐藏的信件。' }],
                },
              },
              'ending',
            ),
          ]);
        else if (results.length === 2) {
          consequenceNodeId = results.find((m: any) => m.tool_call_id === 'ending').value.data
            .nodeId;
          const itemId = results.find((m: any) => m.tool_call_id === 'key').value.data.id;
          answer(res, null, [
            call(
              'edit_choice',
              {
                action: 'add',
                nodeId: 'scene_intro',
                label: '用钥匙打开暗门',
                targetId: results.find((m: any) => m.tool_call_id === 'ending').value.data.nodeId,
                conditionJson: JSON.stringify({
                  kind: 'item',
                  itemId: results.find((m: any) => m.tool_call_id === 'key').value.data.id,
                  op: 'gte',
                  count: 1,
                }),
              },
              'choice',
            ),
            call(
              'edit_event',
              {
                action: 'save',
                nodeId: consequenceNodeId,
                name: '开锁消耗钥匙',
                trigger: 'complete',
                atMs: 0,
                once: false,
                effects: [{ kind: 'removeItem', itemId, count: 1 }],
              },
              'consequence',
            ),
          ]);
        } else {
          consequenceEventId = results.find((m: any) => m.tool_call_id === 'consequence').value.data
            .eventId;
          answer(
            res,
            [
              '### 编辑结果',
              '',
              '1. **已创建钥匙分支**',
              '   - 道具 `item_with_a_long_identifier_for_the_new_branch`',
              '2. 路线 $\\rightarrow$ 结局',
              '',
              '| 条件 | 结果 |',
              '| --- | --- |',
              '| 铜钥匙 | 打开暗门 |',
              '',
              '```json',
              '{"count": 1}',
              '```',
              '',
              '[查看说明](https://example.com) [不安全链接](javascript:alert%281%29)',
              '',
              '<iframe src="https://example.com"></iframe>',
            ].join('\n'),
          );
        }
      } else if (user.includes('制作第一章的蓝图')) {
        if (!results.length) {
          answer(res, null, [
            call(
              'edit_scene',
              {
                action: 'create',
                kind: 'video',
                chapterId: 'chapter_fixture',
                title: '蓝图新增过场',
                notes: '主角沿林道走出树林，来到岔路。',
                storyboardPages: [{ text: '测试传来脚步声。' }],
              },
              'blueprint-create',
            ),
          ]);
        } else held = res;
      } else if (user.includes('取消消耗钥匙')) {
        if (!results.length)
          answer(res, null, [
            call('edit_event', {
              action: 'delete',
              nodeId: consequenceNodeId,
              eventId: consequenceEventId,
            }),
          ]);
        else answer(res, '已取消钥匙消耗，进入条件仍然保留。');
      } else if (user.includes('停止测试')) {
        if (!results.length)
          answer(res, null, [
            call('edit_scene', {
              action: 'batch',
              operations: [
                {
                  action: 'create',
                  kind: 'video',
                  title: '实时写入节点',
                  notes: '灯亮起后，主角辨认眼前房间。',
                  storyboardPages: [{ text: '灯亮了。' }],
                },
                {
                  action: 'create',
                  kind: 'ending',
                  title: '实时写入结局',
                  notes: '以亮灯后的发现收束。',
                  endingText: '灯亮之后，你终于看清了来人。',
                },
              ],
            }),
          ]);
        else if (results.length === 1) {
          const [videoId, endingId] = results[0].value.nodeIds;
          answer(res, null, [
            call(
              'edit_scene',
              {
                action: 'batch',
                operations: [
                  { action: 'connect', fromId: consequenceNodeId, toId: videoId },
                  { action: 'connect', fromId: videoId, toId: endingId },
                ],
              },
              'connect-stop-scenes',
            ),
          ]);
        } else held = res;
      } else if (user.includes('触发冲突') || user.includes('合并手动编辑')) {
        if (!results.length) answer(res, null, [call('read_project', {})]);
        else if (results.length === 1) held = res;
        else answer(res, '已完成合并');
      } else if (user.startsWith('继续') || user.includes('草稿续跑测试')) {
        if (opening) {
          answer(res, null, [
            call(
              'set_task_scope',
              user.startsWith('继续')
                ? { action: 'resume' }
                : { action: 'start', policy: { mode: 'execute', target: { stage: 'outline' } } },
            ),
          ]);
        } else if (user.startsWith('继续')) {
          if (results.some((m: any) => m.tool_call_id === 'resume-variable'))
            answer(res, '已保存剧情节点和属性。');
          else
            answer(res, null, [
              call(
                'edit_game_data',
                {
                  kind: 'variable',
                  name: '续跑属性',
                  type: 'number',
                  initial: 0,
                },
                'resume-variable',
              ),
            ]);
        } else if (!results.some((m: any) => m.tool_call_id === 'draft-scene')) {
          answer(res, null, [
            call(
              'edit_scene',
              {
                action: 'create',
                args: {
                  kind: 'video',
                  title: '续跑剧情',
                  notes: '接上主角离开前的行动，继续调查。',
                  storyboardPages: [{ text: '续跑剧情' }],
                },
              },
              'draft-scene',
            ),
          ]);
        } else if (!results.some((m: any) => m.tool_call_id === 'connect-draft-scene')) {
          const created = results.find((m: any) => m.tool_call_id === 'draft-scene');
          answer(res, null, [
            call(
              'edit_scene',
              {
                action: 'connect',
                fromId: consequenceNodeId,
                toId: created.value.data.nodeId,
              },
              'connect-draft-scene',
            ),
          ]);
        } else if (body.messages[0].content.includes('上次响应未执行')) {
          held = res;
        } else {
          answer(res, null, [], 'length');
        }
      } else answer(res, '当前选中节点已读取。');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      FRAMEFORGE_TEST: '1',
      FRAMEFORGE_USER_DATA: root,
      DEEPSEEK_API_KEY: 'fake-test-key',
    }).filter((v): v is [string, string] => v[1] !== undefined),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.FRAMEFORGE_TEST_EXECUTABLE;
  const app = await launchEditor({ executablePath, args: executablePath ? [] : ['.'], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('complementary', { name: '创作 Agent 对话' })).toBeVisible();
    await page.evaluate(async (baseUrl) => {
      const s = await window.frameforge!.agentSettings.get();
      await window.frameforge!.agentSettings.save({
        defaultProvider: 'deepseek',
        providers: { ...s.providers, deepseek: { ...s.providers.deepseek, baseUrl } },
      });
    }, `http://127.0.0.1:${port}`);
    const composer = page.getByLabel('向创作 Agent 发送消息', { exact: true });
    await expect(composer).toBeEnabled();
    await page.getByLabel('对话模型服务商').selectOption('deepseek');
    if (blueprintLive) {
      const nodes = page.locator('.story-node');
      await composer.fill('现在制作第一章的蓝图');
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect.poll(() => !!held).toBe(true);
      const draft = nodes.filter({
        has: page.getByRole('heading', { name: '蓝图新增过场', exact: true }),
      });
      await expect(draft).toHaveClass(/agent-draft/);
      await expect(draft.getByText('草稿', { exact: true })).toBeVisible();
      expect(
        await page.evaluate(
          async () => (await window.frameforge!.bootstrap()).project.scenes.length,
        ),
      ).toBe(7);
      const created = bodies
        .at(-1)
        .messages.find((message: any) => message.tool_call_id === 'blueprint-create');
      const { nodeId } = JSON.parse(created.content).data;
      await page.getByRole('button', { name: '折叠创作 Agent' }).click();
      answer(held!, null, [
        call(
          'edit_scene',
          { action: 'connect', fromId: nodeId, toId: 'scene_branch' },
          'blueprint-draft-exit',
        ),
      ]);
      held = undefined;
      await expect.poll(() => !!held).toBe(true);
      await expect(page.locator('.react-flow__edge.agent-draft-edge')).toHaveCount(1);
      answer(held!, null, [
        call(
          'edit_scene',
          { action: 'connect', fromId: 'scene_reward', toId: nodeId },
          'blueprint-connect',
        ),
      ]);
      held = undefined;
      await expect.poll(() => !!held).toBe(true);
      await expect(nodes).toHaveCount(8);
      await expect(nodes.getByRole('heading', { name: '蓝图新增过场', exact: true })).toBeVisible();
      await expect(draft).not.toHaveClass(/agent-draft/);
      await page.getByRole('button', { name: '展开创作 Agent' }).click();
      await expect(page.getByRole('button', { name: '停止创作', exact: true })).toBeVisible();
      answer(held!, null, [
        call(
          'edit_scene',
          { action: 'update', nodeId, patch: { title: '蓝图过场已润色' } },
          'blueprint-update',
        ),
      ]);
      held = undefined;
      await expect.poll(() => !!held).toBe(true);
      await expect(
        nodes.getByRole('heading', { name: '蓝图过场已润色', exact: true }),
      ).toBeVisible();
      answer(held!, '第一章蓝图已完成。');
      held = undefined;
      await expect(page.getByRole('button', { name: '停止创作', exact: true })).toHaveCount(0);
      await nodes.getByRole('heading', { name: '蓝图过场已润色', exact: true }).click();
      await page.getByRole('button', { name: '节点内容', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '节点内容', exact: true })).toHaveText(
        '主角沿林道走出树林，来到岔路。',
      );
      await page.getByRole('button', { name: '撤销本轮', exact: true }).click();
      await expect(nodes).toHaveCount(7);
      await expect(page.locator('.agent-change-status')).toContainText('已撤销本轮修改');
      await expect
        .poll(async () => {
          const { project } = JSON.parse(
            await fs.readFile(path.join(root, 'recovery.json'), 'utf8'),
          );
          return project.scenes.find((scene: { id: string }) => scene.id === 'scene_reward')
            .nextId;
        })
        .toBe('scene_branch');
      return;
    }
    await composer.fill('在选中的节点创建钥匙分支，进入后消耗钥匙。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const reply = page.locator('.agent-message-text').first();
    await expect(reply.getByRole('heading', { name: '编辑结果' })).toBeVisible();
    await expect(reply.locator('ol > li > ul code')).toHaveText(
      'item_with_a_long_identifier_for_the_new_branch',
    );
    await expect(reply.locator('strong')).toHaveText('已创建钥匙分支');
    await expect(reply.locator('math mo')).toHaveText('→');
    await expect(reply.getByRole('cell', { name: '铜钥匙' })).toBeVisible();
    await expect(reply.locator('pre code')).toContainText('{"count": 1}');
    await expect(reply.getByRole('link', { name: '查看说明' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
    await expect(reply.getByRole('link', { name: '不安全链接' })).toHaveCount(0);
    await expect(reply.locator('iframe')).toHaveCount(0);
    expect(bodies[0].messages[0].content).toContain('scene_intro');
    const initialTools = bodies[0].tools.map((tool: any) => tool.function.name);
    expect(initialTools).not.toContain('complete_task_stage');
    expect(initialTools).toContain('set_task_scope');
    expect(initialTools).toEqual(
      expect.arrayContaining([
        'edit_scene',
        'read_story',
        'check_story',
        'read_conversation',
        'edit_world_setting',
        'read_world_settings',
      ]),
    );
    await expect(page.locator('.story-node')).toHaveCount(8);
    await expect(page.locator('.agent-change-status')).toContainText('已提交 4 项编辑');
    await expect
      .poll(async () => {
        const { project } = JSON.parse(await fs.readFile(path.join(root, 'recovery.json'), 'utf8'));
        return project.scenes.find((node: { id: string }) => node.id === consequenceNodeId)?.notes;
      })
      .toBe('主角进门，在桌角找到并展开信件。');
    await composer.fill('取消消耗钥匙');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.locator('.agent-message-text').last()).toContainText('已取消钥匙消耗');
    // Inspect the app's own autosave through its isolated recovery record.
    await expect
      .poll(
        async () =>
          JSON.parse(
            await fs.readFile(path.join(root, 'recovery.json'), 'utf8'),
          ).project.scenes.find((s: any) => s.id === consequenceNodeId).events,
      )
      .toEqual([]);
    await page.getByRole('button', { name: '撤销本轮', exact: true }).last().click();
    await expect(page.locator('.agent-change-status').last()).toContainText('已撤销本轮修改');
    await composer.fill('直接执行停止测试');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => !!held).toBe(true);
    await expect(page.locator('.story-node')).toHaveCount(10);
    await page.getByRole('button', { name: '停止创作', exact: true }).click();
    await expect(page.locator('.agent-message-text').last()).toContainText('已停止');
    releaseHeld();
    await expect(page.locator('.story-node')).toHaveCount(10);
    await page.getByRole('button', { name: '撤销本轮', exact: true }).last().click();
    await expect(page.locator('.story-node')).toHaveCount(8);
    await composer.fill('直接执行触发冲突');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => !!held).toBe(true);
    await page.getByRole('button', { name: '编辑节点名称', exact: true }).click();
    await page.getByLabel('节点名称', { exact: true }).fill('用户手动保留的节点');
    answer(held!, null, [
      call('edit_scene', {
        action: 'update',
        nodeId: 'scene_intro',
        patch: { title: '不应覆盖手动修改' },
      }),
    ]);
    held = undefined;
    await expect(page.locator('.agent-message-text').last()).toContainText('本轮修改未提交');
    await expect(page.getByLabel('节点名称', { exact: true })).toHaveValue('用户手动保留的节点');
    await page.reload();
    await expect(page.locator('.agent-turn')).toHaveCount(4);
    await expect(reply.locator('strong')).toHaveText('已创建钥匙分支');
    await expect(page.locator('.agent-message-text').last()).toContainText('本轮修改未提交');
    await expect(page.locator('.agent-message-text').last()).toContainText(
      'scenes[scene_intro].title',
    );
    await composer.fill('直接执行合并手动编辑');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => !!held).toBe(true);
    await page.getByRole('button', { name: '节点内容', exact: true }).click();
    await page.getByLabel('节点内容', { exact: true }).fill('同时保留的手动备注');
    answer(held!, null, [
      call('edit_scene', {
        action: 'update',
        nodeId: 'scene_intro',
        patch: { title: 'Agent 合并标题' },
      }),
    ]);
    held = undefined;
    await expect(page.locator('.agent-change-status').last()).toContainText('已提交 1 项编辑');
    await expect(page.getByLabel('节点内容', { exact: true })).toHaveText('同时保留的手动备注');
    await expect(
      page.getByRole('heading', { name: 'Agent 合并标题', exact: true }).first(),
    ).toBeVisible();
    await page.getByRole('button', { name: '撤销本轮', exact: true }).last().click();
    await expect(page.getByLabel('节点内容', { exact: true })).toHaveText('同时保留的手动备注');
    await composer.fill('直接执行草稿续跑测试');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => !!held).toBe(true);
    await expect(page.locator('.agent-run-status')).toHaveText('修正并继续');
    await expect(page.locator('.story-node')).toHaveCount(9);
    await page.getByRole('button', { name: '停止创作', exact: true }).click();
    releaseHeld();
    await expect(page.locator('.agent-message-text').last()).toContainText('「继续」');
    await expect(page.locator('.story-node')).toHaveCount(9);
    await page.reload();
    await expect(page.locator('.agent-message-text').last()).toContainText('「继续」');
    await composer.fill('继续');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.locator('.agent-change-status').last()).toContainText('已提交 1 项编辑');
    await expect(page.locator('.story-node')).toHaveCount(9);
    await expect(page.locator('.agent-message-text').last()).toContainText('已保存剧情节点和属性');
    await page.getByRole('button', { name: '撤销本轮', exact: true }).last().click();
    await expect(page.locator('.story-node')).toHaveCount(9);
    // Packaged tests keep the native window hidden, where captures can stall.
    if (!executablePath) await page.screenshot({ path: '.local/previews/agent-working.png' });
  } finally {
    releaseHeld();
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
