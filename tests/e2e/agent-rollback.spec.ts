import { test, expect } from './fixtures';

test('undoes both live Agent batches and preserves the author edit between them after reload', async ({
  page,
}) => {
  await page.goto('/');
  const composer = page.getByLabel('向创作 Agent 发送消息', { exact: true });
  await expect(composer).toBeEnabled();
  const before = await page.evaluate(async () => {
    const agentPath = '/src/platform/agent.ts';
    const editorPath = '/src/store/editor.ts';
    const { agentAPI } = await import(agentPath);
    const { useEditor } = await import(editorPath);
    const project = useEditor.getState().project;
    const node = project.scenes.find(({ id }: { id: string }) => id === project.startNodeId);
    let round = 0;
    const frame = { text: '', raw: {}, finish: 'complete', calls: [] };
    agentAPI.complete = async ({ purpose }: { purpose?: string }) => {
      if (purpose === 'request_plan') return { ...frame, text: '{"kind":"execute"}' };
      if (round === 2) return { ...frame, text: '两批编辑已完成。' };
      if (round === 1)
        useEditor.getState().commit((draft: { description: string }) => {
          draft.description = '作者自己的作品简介';
        });
      const patch = round === 0 ? { title: 'Agent 新节点名' } : { notes: 'Agent 节点制作备注' };
      return {
        ...frame,
        calls: [
          {
            id: `change-${round++}`,
            name: 'edit_scene',
            arguments: JSON.stringify({ action: 'update', nodeId: node.id, patch }),
          },
        ],
      };
    };
    return { id: node.id, title: node.title, notes: node.notes };
  });
  await composer.fill('修改当前节点的标题和备注');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const undo = page.getByRole('button', { name: '撤销本轮', exact: true });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(page.getByText('已撤销本轮修改', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('已撤销本轮修改', { exact: true })).toBeVisible();
  const restored = await page.evaluate(async (id) => {
    const editorPath = '/src/store/editor.ts';
    const { useEditor } = await import(editorPath);
    const { description, scenes } = useEditor.getState().project;
    return { description, node: scenes.find((row: { id: string }) => row.id === id) };
  }, before.id);
  expect(restored.description).toBe('作者自己的作品简介');
  expect(restored.node).toMatchObject(before);
});

test('rolls back the chat and project together and uses the restored history after reload', async ({
  page,
}) => {
  await page.goto('/');
  const composer = page.getByLabel('向创作 Agent 发送消息', { exact: true });
  await expect(composer).toBeEnabled();

  const mockAgent = () =>
    page.evaluate(async () => {
      const platformPath = '/src/platform/agent.ts';
      const { agentAPI } = await import(platformPath);
      agentAPI.complete = async (request: {
        purpose?: string;
        messages: { content: string }[];
        system: string;
        exchanges: unknown[];
      }) => {
        const input = request.messages.at(-1)!.content;
        if (request.purpose === 'request_plan') {
          const { request: user } = JSON.parse(input) as { request: string };
          const plan = user.startsWith('后续工程')
            ? { kind: 'execute', design: { outline: true } }
            : { kind: 'read' };
          return { text: JSON.stringify(plan), calls: [], raw: {}, finish: 'complete' };
        }
        const history = request.messages.map(({ content }) => content).join('\n');
        if (input.startsWith('回退后检查')) {
          if (history.includes('后续工程') || request.system.includes('后续记忆'))
            throw new Error('后续上下文被发送给模型');
          if (!history.includes('第一轮构想') || !history.includes('第一轮回复'))
            throw new Error('回退点的历史缺失');
          return { text: '已读取回退后的上下文', calls: [], raw: {}, finish: 'complete' };
        }
        if (input.startsWith('后续工程') && !request.exchanges.length)
          return {
            text: '',
            calls: [
              {
                id: 'save-outline',
                name: 'edit_story_design',
                arguments: JSON.stringify({
                  target: { stage: 'outline' },
                  text: '后续大纲正文',
                }),
              },
            ],
            raw: {},
            finish: 'complete',
          };
        return {
          text: input.startsWith('第一轮构想') ? '第一轮回复' : '后续回复',
          calls: [],
          raw: {},
          finish: 'complete',
        };
      };
    });
  await mockAgent();
  const send = async (message: string) => {
    await composer.fill(message);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
  };
  const rollback = page.getByRole('button', { name: '回退到此轮', exact: true });
  await send('第一轮构想');
  await expect(rollback.first()).toBeEnabled();
  await send('后续工程');
  await expect(page.getByText('已保存大纲草稿。', { exact: true })).toBeVisible();
  await expect(rollback).toHaveCount(2);
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');

  const projectState = () =>
    page.evaluate(async () => {
      const editorPath = '/src/store/editor.ts';
      const { useEditor } = await import(editorPath);
      return useEditor.getState().project.storyDesign?.outline?.text ?? null;
    });
  expect(await projectState()).toBe('后续大纲正文');
  await page.evaluate(async () => {
    const storePath = '/src/store/agent.ts';
    const { useAgent } = await import(storePath);
    const session = useAgent.getState().session;
    useAgent.setState({
      session: { ...session, memory: { ...session.memory, summary: '后续记忆', through: 2 } },
    });
    await useAgent.getState().flush();
  });

  await page.reload();
  await expect(rollback.first()).toBeEnabled();
  await page.setViewportSize({ width: 1100, height: 800 });
  await rollback.first().click();
  const dialog = page.getByRole('dialog', { name: '回退到第 1 轮？' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认回退' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.agent-turn')).toHaveCount(1);
  expect(await projectState()).toBeNull();

  await page.reload();
  await expect(page.locator('.agent-turn')).toHaveCount(1);
  expect(await projectState()).toBeNull();
  await mockAgent();
  await send('回退后检查');
  await expect(page.getByText('已读取回退后的上下文', { exact: true })).toBeVisible();
});

test('restores the pending host task at the chosen turn and resumes only its unfinished chapter', async ({
  page,
}) => {
  let failChapterGateway!: () => void;
  const gateway = new Promise<void>((resolve) => {
    failChapterGateway = resolve;
  });
  await page.exposeFunction('waitForChapterGateway', () => gateway);
  await page.goto('/');
  const composer = page.getByLabel('向创作 Agent 发送消息', { exact: true });
  const send = async (text: string) => {
    await composer.fill(text);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
  };
  const installModel = () =>
    page.evaluate(async () => {
      const platformPath = '/src/platform/agent.ts';
      const editorPath = '/src/store/editor.ts';
      const { agentAPI } = await import(platformPath);
      const { useEditor } = await import(editorPath);
      agentAPI.complete = async (request: {
        purpose?: string;
        messages: { content: string }[];
        exchanges: unknown[];
      }) => {
        const input = request.messages.at(-1)!.content;
        if (request.purpose === 'request_plan') {
          const { request: user } = JSON.parse(input) as { request: string };
          const plan = user.startsWith('写完两章')
            ? {
                kind: 'execute',
                design: { chapter: true, chapters: { kind: 'range', from: 1, through: 2 } },
              }
            : { kind: user === '继续' ? 'resume' : 'status' };
          return { text: JSON.stringify(plan), calls: [], raw: {}, finish: 'complete' };
        }
        if (input.startsWith('写完两章') && request.exchanges.length) {
          const fakeGateway = window as Window & { waitForChapterGateway?: () => Promise<void> };
          await fakeGateway.waitForChapterGateway!();
          throw new Error('网关暂时不可用');
        }
        const args = input.startsWith('写完两章')
          ? {
              action: 'update',
              chapterId: useEditor.getState().project.chapters[0].id,
              patch: {},
              designText: '第一章已写。',
            }
          : { action: 'create', title: '第二章', designText: '第二章续写。' };
        if (
          input.startsWith('继续') &&
          (!input.includes('"ordinal":2') || !input.includes('第一章已写。'))
        )
          throw new Error('未恢复正确的续跑上下文');
        return {
          text: '',
          calls: [
            { id: crypto.randomUUID(), name: 'edit_chapter', arguments: JSON.stringify(args) },
          ],
          raw: {},
          finish: 'complete',
        };
      };
    });
  const state = () =>
    page.evaluate(async () => {
      const agentPath = '/src/store/agent.ts';
      const editorPath = '/src/store/editor.ts';
      const { useAgent } = await import(agentPath);
      const { useEditor } = await import(editorPath);
      const checkpoint = useAgent.getState().session?.checkpoint;
      const project = checkpoint?.draft ?? useEditor.getState().project;
      return {
        task: checkpoint?.hostTask?.id ?? null,
        texts: project.storyDesign?.chapters.map(({ text }: { text: string }) => text) ?? [],
      };
    });
  await installModel();
  await send('写完两章剧本');
  const completion = page.getByRole('region', { name: '分章节大纲已完成' });
  try {
    await expect(page.getByText('处理中', { exact: true })).toBeVisible();
    await expect(page.getByText('编辑章节', { exact: true })).toBeVisible();
    await expect(completion).toHaveCount(0);
  } finally {
    failChapterGateway();
  }
  await expect(page.getByText(/网关暂时不可用/).last()).toBeVisible();
  await expect(completion).toHaveCount(0);
  await expect.poll(async () => (await state()).texts).toEqual(['第一章已写。']);
  await expect.poll(async () => (await state()).task).toBeTruthy();
  const { task } = await state();
  await send('现在项目进行到什么阶段了');
  const rollback = page.getByRole('button', { name: '回退到此轮', exact: true });
  await expect(rollback.first()).toBeEnabled();
  await expect(page.getByText(/已完成 1\/2 个步骤/)).toBeVisible();
  await send('继续');
  await expect.poll(state).toEqual({ task: null, texts: ['第一章已写。', '第二章续写。'] });
  await expect(completion).toHaveCount(1);
  await expect(completion.getByRole('button', { name: '搭建章节蓝图' })).toBeEnabled();
  await expect(rollback).toHaveCount(2);
  await rollback.first().click();
  await page.getByRole('button', { name: '确认回退' }).click();
  await expect.poll(state).toEqual({ task, texts: ['第一章已写。'] });
  await page.reload();
  await expect.poll(state).toEqual({ task, texts: ['第一章已写。'] });
  await expect(completion).toHaveCount(0);
  await installModel();
  await send('继续');
  await expect.poll(state).toEqual({ task: null, texts: ['第一章已写。', '第二章续写。'] });
});
