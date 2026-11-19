import { clickPlayerAction, resumePlayer } from './player-helpers';
import { test, expect, type Page } from './fixtures';
import { testProject } from '../fixtures/project';
import { unzipSync, strFromU8 } from 'fflate';
import fs from 'node:fs/promises';

async function createChapter(page: Page, title: string) {
  await page.getByRole('button', { name: '故事大纲', exact: true }).click();
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
  await page.getByLabel('章节名称', { exact: true }).fill(title);
  await page.getByRole('button', { name: '创建章节', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function manage(page: Page, title: string, action: string) {
  await page.getByRole('button', { name: `管理章节 ${title}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '创作资源' })).toBeVisible();
});

test('creates an empty chapter, adds nodes in that chapter, edits the entry and persists a portable project', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createChapter(page, '第二章 · 回声');
  const scope = page.getByLabel('当前章节');
  await expect(scope.locator('option:checked')).toHaveText('第二章 · 回声');
  await expect(page.locator('.story-node')).toHaveCount(0);
  await expect(page.getByText('本章暂无节点', { exact: true })).toBeVisible();
  await page
    .locator('.chapter-canvas-empty')
    .getByRole('button', { name: '添加节点', exact: true })
    .click();
  const edit = page.getByRole('button', { name: '编辑节点名称', exact: true });
  await edit.click();
  await page.getByLabel('节点名称', { exact: true }).fill('第二章开场');
  await expect(page.getByLabel('所属章节').locator('option:checked')).toHaveText('第二章 · 回声');
  await expect(page.getByRole('button', { name: '已设为起点', exact: true })).toBeVisible();
  await page.getByLabel('节点名称', { exact: true }).blur();
  await page.keyboard.press('e');
  await edit.click();
  await page.getByLabel('节点名称', { exact: true }).fill('第二章结局');
  await page.getByRole('button', { name: '设为起点', exact: true }).click();
  await manage(page, '第二章 · 回声', '章节设置');
  await page.getByLabel('章节名称', { exact: true }).fill('终章 · 回声');
  await expect(page.getByLabel('章节起点').locator('option:checked')).toHaveText('第二章结局');
  await page.getByRole('button', { name: '保存章节', exact: true }).click();
  await expect(scope.locator('option:checked')).toHaveText('终章 · 回声');
  await manage(page, '终章 · 回声', '上移章节');
  await expect(page.locator('.chapter-name').first()).toContainText('终章 · 回声');
  await page.screenshot({ path: 'test-results/chapters-editor.png', fullPage: true });
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await page.getByRole('button', { name: '故事大纲', exact: true }).click();
  await expect(page.locator('.chapter-name').first()).toContainText('终章 · 回声');
  await scope.selectOption({ label: '终章 · 回声' });
  await expect(page.locator('.story-node')).toHaveCount(2);
  await page.getByRole('button', { name: '试玩本章', exact: true }).click();
  await expect(page.locator('.player-ending h2')).toContainText('故事未完');
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await page.getByRole('button', { name: '退出试玩', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程（Ctrl S）', exact: true }).click();
  const download = await downloading;
  const archive = unzipSync(new Uint8Array(await fs.readFile((await download.path())!)));
  const saved = JSON.parse(strFromU8(archive['project.frameforge']));
  expect(saved.formatVersion).toBe(4);
  expect(saved.chapters.map((c: { title: string }) => c.title)).toEqual([
    '终章 · 回声',
    '第一章 · 测试章节',
  ]);
  expect(saved.chapters[0].startNodeId).toBe(
    saved.scenes.find((s: { title: string }) => s.title === '第二章结局').id,
  );
  expect(errors).toEqual([]);
});

test('moves selected nodes, locates cross-chapter links and plays across chapters without losing state', async ({
  page,
}) => {
  test.setTimeout(60000);
  await createChapter(page, '第二章');
  await page.getByLabel('当前章节').selectOption('');
  const outline = page.locator('.chapter-nodes');
  await outline.getByRole('button', { name: /奖励节点/ }).click();
  await outline.getByRole('button', { name: /条件节点/ }).click({ modifiers: ['Shift'] });
  await expect(page.getByText('已选择 2 个节点', { exact: true })).toBeVisible();
  await page.getByLabel('批量移入章节').selectOption({ label: '第二章' });
  await page.getByLabel('当前章节').selectOption({ label: '第一章 · 测试章节' });
  await expect(page.locator('.story-node')).toHaveCount(testProject().scenes.length - 2);
  await expect(
    page.locator('.node-cross-links').getByRole('button', { name: /跨章 → 第二章 \/ 奖励节点/ }),
  ).toHaveCount(2);
  await page
    .locator('.node-cross-links')
    .getByRole('button', { name: /跨章 → 第二章 \/ 奖励节点/ })
    .first()
    .click();
  await expect(page.getByLabel('当前章节').locator('option:checked')).toHaveText('第二章');
  await expect(page.locator('.inspector-scene-title h2')).toHaveText('奖励节点');
  await expect(page.locator('.story-node')).toHaveCount(2);
  await page.getByRole('button', { name: '试玩 F5' }).click();
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await resumePlayer(page);
  await page.getByRole('button', { name: /进入路线 A/ }).click();
  await clickPlayerAction(page, '运行状态');
  await expect(page.locator('.debug-value').filter({ hasText: '信任' })).toContainText('45');
  await expect(page.locator('.debug-value').filter({ hasText: '测试道具' })).toContainText('× 1');
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '存档', exact: true }).click();
  await page.getByRole('button', { name: /01 空存档/ }).click();
  await expect(page.locator('.player-ending h2')).toContainText('结局 A', {
    timeout: 23000,
  });
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '读档', exact: true }).click();
  await page.getByRole('button', { name: /01 奖励节点/ }).click();
  await expect(page.locator('.debug-value').filter({ hasText: '测试道具' })).toContainText('× 1');
});

test('deletes chapters by moving their nodes and restores the whole change with undo', async ({
  page,
}) => {
  await createChapter(page, '接收章节');
  await manage(page, '第一章 · 测试章节', '删除章节');
  await expect(page.getByRole('dialog')).toContainText(`${testProject().scenes.length} 个节点`);
  await page.getByLabel('节点移入章节').selectOption({ label: '接收章节' });
  await page.getByRole('button', { name: '删除并保留节点', exact: true }).click();
  await expect(page.locator('.chapter-name')).toHaveCount(1);
  await expect(page.locator('.story-node')).toHaveCount(testProject().scenes.length);
  await expect(page.getByRole('button', { name: '工程检查通过', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '撤销（Ctrl Z）', exact: true }).click();
  await expect(page.locator('.chapter-name')).toHaveCount(2);
  await page.getByRole('button', { name: '重做（Ctrl Shift Z）', exact: true }).click();
  await expect(page.locator('.chapter-name')).toHaveCount(1);
  await page.getByRole('button', { name: '管理章节 接收章节', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '删除章节', exact: true })).toHaveAttribute(
    'data-disabled',
  );
});

test('migrates old multi-chapter projects and preserves empty chapters across reload', async ({
  page,
}) => {
  const original = testProject();
  const legacy = {
    ...original,
    formatVersion: 1,
    scenes: original.scenes.map(({ chapterId: _chapterId, notes, endingText, ...scene }, i) => ({
      ...scene,
      chapter: i < 3 ? '旧上篇' : '旧下篇',
      description: scene.kind === 'ending' ? endingText : notes,
    })),
  };
  await page.evaluate(
    (p) => localStorage.setItem('frameforge.project.v1', JSON.stringify(p)),
    legacy,
  );
  await page.reload();
  await page.getByRole('button', { name: '故事大纲', exact: true }).click();
  await expect(page.locator('.chapter-name')).toHaveCount(2);
  await page.getByLabel('当前章节').selectOption({ label: '旧下篇' });
  await expect(page.locator('.story-node')).toHaveCount(
    legacy.scenes.filter(({ chapter }) => chapter === '旧下篇').length,
  );
  await createChapter(page, '留待创作');
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await page.getByLabel('当前章节').selectOption({ label: '留待创作' });
  await expect(page.locator('.story-node')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '试玩本章', exact: true })).toBeDisabled();
});

test('validates chapter names and supports drag-moving nodes onto chapters', async ({ page }) => {
  await createChapter(page, '第二章');
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
  await page.getByLabel('章节名称', { exact: true }).fill('第二章');
  await page.getByRole('button', { name: '创建章节', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('已存在同名章节。');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  const source = page.locator('.chapter-nodes').getByRole('button', { name: /测试开场/ });
  const target = page
    .locator('.chapter-section')
    .filter({ has: page.getByRole('button', { name: '编辑章节 第二章', exact: true }) })
    .locator('.chapter-heading');
  await source.dragTo(target);
  await page.getByLabel('当前章节').selectOption({ label: '第二章' });
  await expect(page.locator('.story-node')).toHaveCount(1);
  await expect(page.locator('.story-node h3')).toHaveText('测试开场');
  await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
  await expect(page.locator('.player-scene-title h2')).toHaveText('奖励节点');
});

test('configures cross-chapter choices and arranges only the visible chapter', async ({ page }) => {
  await createChapter(page, '终章');
  await page.getByRole('button', { name: '添加节点', exact: true }).first().click();
  await page.getByRole('menuitem', { name: '故事结局' }).click();
  await page.getByRole('button', { name: '编辑节点名称', exact: true }).click();
  await page.getByLabel('节点名称', { exact: true }).fill('旅途终点');
  await page.getByLabel('结局标题').fill('跨章抵达');
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  const before = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('frameforge.project.v1')!),
  );
  await page.getByRole('button', { name: '自动整理蓝图', exact: true }).click();
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  const after = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('frameforge.project.v1')!),
  );
  for (const s of before.scenes.filter(
    (s: { chapterId: string }) => s.chapterId === before.chapters[0].id,
  ))
    expect(after.layout[s.id]).toEqual(before.layout[s.id]);
  await page.getByLabel('当前章节').selectOption('');
  await page.getByRole('button', { name: '适应画布' }).click();
  const source = page.locator(
    '.react-flow__node[data-id="scene_intro"] .react-flow__handle[data-handleid="choice_explore"]',
  );
  const target = page
    .locator('.react-flow__node')
    .filter({ hasText: '旅途终点' })
    .locator('.react-flow__handle-left');
  await source.hover();
  await target.hover();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 22 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge[data-id="choice_explore"]')).toHaveAttribute(
    'aria-label',
    new RegExp(after.scenes.find((scene: { title: string }) => scene.title === '旅途终点').id),
  );
  await page.getByLabel('当前章节').selectOption({ label: '第一章 · 测试章节' });
  await page
    .locator('.chapter-nodes')
    .getByRole('button', { name: /测试开场/ })
    .click();
  await page.getByRole('button', { name: /选项\s*2/ }).click();
  await page.locator('.choice-editor summary').first().click();
  await expect(page.getByLabel('跳转目标')).toHaveCount(0);
  await expect(page.locator('.cross-chapter-target')).toContainText('终章 / 旅途终点');
  await expect(page.locator('.story-node')).toHaveCount(testProject().scenes.length);
  await page.getByRole('button', { name: '试玩 F5' }).click();
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await resumePlayer(page);
  await page.getByRole('button', { name: /进入路线 A/ }).click();
  await expect(page.locator('.player-ending h2')).toHaveText('跨章抵达');
});
