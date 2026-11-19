import { expect } from '@playwright/test';
import { seedBrowserProject, testWithWorkspace as test } from './workspace-fixture';
import { testProject } from '../fixtures/project';

test('writes and reopens screenplay, then reads two choices and their different endings', async ({
  page,
}) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '主导航' });
  await nav.getByRole('button', { name: '剧本', exact: true }).click();
  const screenplay = page.getByRole('tab', { name: '章节剧本', exact: true });
  await screenplay.click();
  const sheet = page.getByRole('region', { name: '章节剧本', exact: true });
  await expect(sheet.getByRole('heading', { level: 1 })).toHaveCSS('font-size', '26px');
  const directory = sheet.getByRole('navigation', { name: '章节目录' });
  await expect(directory).toBeVisible();
  await expect(sheet.getByRole('combobox', { name: '路线入口', exact: true })).toHaveCount(0);
  await sheet.getByRole('button', { name: '编写正文', exact: true }).click();
  await sheet.getByRole('textbox', { name: '第 1 段内容' }).fill('主角摊开没有署名的信。');
  await sheet.getByRole('button', { name: '添加段落' }).click();
  await sheet.getByLabel('第 2 段类型').selectOption('dialogue');
  await sheet.getByRole('textbox', { name: '第 2 段说话人' }).fill('主角');
  await sheet.getByRole('textbox', { name: '第 2 段内容' }).fill('有人吗？');
  await sheet.getByRole('button', { name: '保存正文' }).click();
  await expect(sheet.getByText('对白 · 主角', { exact: true })).toBeVisible();
  await expect(page.getByText('已自动保存', { exact: true })).toBeVisible();
  await page.reload();
  await nav.getByRole('button', { name: '剧本', exact: true }).click();
  await screenplay.click();
  await expect(sheet.getByText('主角摊开没有署名的信。')).toHaveCSS('font-size', '13px');
  await sheet.getByRole('button', { name: '进入路线 A' }).click();
  await expect(sheet.getByRole('heading', { name: '奖励节点', exact: true })).toBeVisible();
  await expect(sheet.getByRole('heading', { name: '结局 A', exact: true })).toBeVisible();
  const nodeList = sheet.getByRole('navigation', { name: '本路线节点' });
  await nodeList.getByRole('button', { name: '奖励节点', exact: true }).click();
  await expect(sheet.locator('article[tabindex="-1"]:focus')).toContainText('奖励节点');
  await page.getByRole('tab', { name: '分章节大纲', exact: true }).click();
  await screenplay.click();
  await expect(sheet.getByRole('heading', { name: '结局 A', exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: '退回上一选项' }).click();
  await sheet.getByRole('button', { name: '进入路线 B' }).click();
  await sheet.getByRole('button', { name: '继续向前' }).click();
  await expect(sheet.getByRole('heading', { name: '结局 B', exact: true })).toBeVisible();
  await expect(sheet.getByRole('heading', { name: '结局 A', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 720, height: 680 });
  await expect(directory).toBeHidden();
  await expect(sheet.getByLabel('正文章节')).toBeVisible();
});

test('reads the chosen chapter directly and shares the chapter with its outline', async ({
  page,
}) => {
  const project = testProject();
  const second = 'chapter_gate';
  project.chapters.push({ id: second, title: '第二章 · 石门', startNodeId: 'scene_branch' });
  for (const scene of project.scenes.slice(3)) scene.chapterId = second;
  await seedBrowserProject(page, project);
  await page.goto('/');
  await page.getByRole('button', { name: '剧本', exact: true }).click();
  const screenplay = page.getByRole('tab', { name: '章节剧本', exact: true });
  await screenplay.click();
  const directory = page.getByRole('navigation', { name: '章节目录' });
  await directory.getByRole('button', { name: '第二章 · 石门', exact: true }).click();
  await expect(page.getByRole('heading', { name: '第二章 · 石门', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '结局 B', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '进入路线 A' })).toHaveCount(0);
  await page.getByRole('tab', { name: '分章节大纲', exact: true }).click();
  await expect(page.getByRole('heading', { name: '第二章 · 石门', level: 1 })).toBeVisible();
  await screenplay.click();
  await expect(
    directory.getByRole('button', { name: '第二章 · 石门', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

test('offers next and review actions on the screenplay completion card', async ({ page }) => {
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const modulePath = '/src/store/agent.ts';
        const { useAgent } = (await import(modulePath)) as typeof import('../../src/store/agent');
        return Boolean(useAgent.getState().session && !useAgent.getState().loading);
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const modulePath = '/src/store/agent.ts';
    const { useAgent } = (await import(modulePath)) as typeof import('../../src/store/agent');
    const { session } = useAgent.getState();
    useAgent.setState({
      session: {
        ...session!,
        turns: [
          {
            id: 'sample-screenplay',
            user: '编写所选节点正文',
            assistant: '已保存 1 个节点的剧本正文。',
            status: 'completed',
            provider: 'deepseek',
            model: 'test',
            committed: true,
            createdAt: new Date().toISOString(),
            traces: [],
            changedNodeIds: ['scene_intro'],
            hostTask: {
              id: crypto.randomUUID(),
              steps: [
                {
                  kind: 'screenplay',
                  chapterId: 'chapter_fixture',
                  selectedIds: ['scene_intro'],
                  targetNodeIds: ['scene_intro'],
                  done: true,
                  receipts: { scene_intro: crypto.randomUUID() },
                },
              ],
            },
          },
        ],
      },
      send: async (user, stagePlan) => {
        sessionStorage.setItem('next-stage-test', JSON.stringify({ user, stagePlan }));
      },
    });
  });
  const card = page.getByRole('region', { name: '章节剧本已完成' });
  const next = card.getByRole('button', { name: '生成分镜与玩家文字', exact: true });
  await expect(next).toBeVisible();
  await card.getByRole('textbox').fill('保留原对白。');
  await next.click();
  await expect
    .poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('next-stage-test') ?? '{}')))
    .toMatchObject({
      user: expect.stringContaining('保留原对白。'),
      stagePlan: { production: { scope: 'selected', fromScreenplay: true } },
    });
  await card.getByRole('button', { name: '回看调整' }).click();
  await expect(page.getByRole('tab', { name: '章节剧本', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('heading', { name: '第一章 · 测试章节', level: 1 })).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: '章节目录' })
      .getByRole('button', { name: '第一章 · 测试章节', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});
