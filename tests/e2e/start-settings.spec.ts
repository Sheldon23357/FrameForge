import { test, expect } from './fixtures';

test('keeps chapter and start controls together above the inspector tabs at narrow widths', async ({
  page,
}) => {
  await page.goto('/');
  const inspector = page.locator('.inspector');
  const resize = page.getByRole('separator', { name: '调整检查器宽度' });
  const handle = (await resize.boundingBox())!;
  const x = handle.x + handle.width / 2;
  const y = handle.y + 150;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 48, y, { steps: 5 });
  await page.mouse.up();
  await expect(resize).toHaveAttribute('aria-valuenow', '256');
  await resize.press('ArrowRight');
  await expect(resize).toHaveAttribute('aria-valuenow', '240');
  await page.reload();
  await expect(resize).toHaveAttribute('aria-valuenow', '240');
  await page.setViewportSize({ width: 900, height: 800 });

  const chapter = inspector.getByRole('combobox', { name: '所属章节' });
  const start = inspector.getByRole('button', { name: '已设为起点', exact: true });
  await expect(chapter).toBeInViewport();
  await expect(start).toBeInViewport();
  await expect(inspector.getByRole('heading', { name: '基本信息' })).toHaveCount(0);
  const titleBox = (await inspector.locator('.inspector-node-heading').boundingBox())!;
  const chapterBox = (await chapter.boundingBox())!;
  const startBox = (await start.boundingBox())!;
  const tabsBox = (await inspector.locator('.inspector-tabs').boundingBox())!;
  expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(chapterBox.y);
  expect(chapterBox.y + chapterBox.height).toBeLessThanOrEqual(tabsBox.y);
  expect(startBox.y).toBe(chapterBox.y);
  expect(startBox.x).toBeGreaterThan(chapterBox.x + chapterBox.width);
  await inspector.getByRole('button', { name: /^选项/ }).click();
  await expect(chapter).toBeVisible();
  await expect(start).toBeVisible();

  await page.locator('.workspace-topbar').getByRole('button', { name: '折叠创作资源' }).click();
  await expect(page.locator('.agent-panel')).toBeVisible();
  await expect(page.locator('.blueprint')).toBeVisible();
  await expect(chapter).toBeInViewport();
  await expect(start).toBeInViewport();
  await page.getByRole('button', { name: '展开创作资源' }).click();
  await expect(page.locator('.library-panel')).toBeVisible();
  await expect(chapter).toBeInViewport();
});

test('sets one chapter start, uses it as the first chapter opening, and restores both on undo', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '故事大纲', exact: true }).click();
  const outline = page.locator('.chapter-nodes');
  await outline.getByRole('button', { name: /奖励节点/ }).click();
  await expect(page.locator('.inspector .start-toggle')).toHaveCount(1);
  await page.getByRole('button', { name: '设为起点', exact: true }).click();
  await expect(page.getByRole('button', { name: '已设为起点', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(outline.getByRole('button', { name: /奖励节点/ })).toContainText('起点');
  await page.getByRole('button', { name: '试玩 F5' }).click();
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await expect(page.locator('.player-scene-title h2')).toHaveText('奖励节点');
  await page.getByRole('button', { name: '退出试玩', exact: true }).click();
  await page.getByRole('button', { name: '撤销（Ctrl Z）', exact: true }).click();
  await expect(page.getByRole('button', { name: '设为起点', exact: true })).toBeVisible();
  await expect(outline.getByRole('button', { name: /测试开场/ })).toContainText('起点');
  await page.getByRole('button', { name: '重做（Ctrl Shift Z）', exact: true }).click();
  await expect(page.getByRole('button', { name: '已设为起点', exact: true })).toBeVisible();
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await expect(page.locator('.inspector-scene-title h2')).toHaveText('奖励节点');
  await expect(page.getByRole('button', { name: '已设为起点', exact: true })).toBeVisible();
  await page.screenshot({
    path: '.local/start-settings-unified.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('uses chapter order for the opening and omits the opening control from project settings', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '故事大纲', exact: true }).click();
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
  await page.getByLabel('章节名称', { exact: true }).fill('第二章');
  await page.getByRole('button', { name: '创建章节', exact: true }).click();
  await page.getByRole('button', { name: '添加节点', exact: true }).first().click();
  await page.getByRole('menuitem', { name: '故事结局' }).click();
  await page.getByRole('button', { name: '编辑节点名称', exact: true }).click();
  await page.getByLabel('节点名称', { exact: true }).fill('第二章开场');
  await page.getByLabel('结局标题').fill('章节重排后的开场');
  await page.getByRole('button', { name: '试玩 F5' }).click();
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await expect(page.locator('.player-scene-title h2')).toHaveText('测试开场');
  await page.getByRole('button', { name: '退出试玩', exact: true }).click();
  await page.getByRole('button', { name: '管理章节 第二章', exact: true }).click();
  await page.getByRole('menuitem', { name: '上移章节', exact: true }).click();
  await page.getByRole('button', { name: '试玩 F5' }).click();
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await expect(page.locator('.player-ending h2')).toHaveText('章节重排后的开场');
  await page.getByRole('button', { name: '退出试玩', exact: true }).click();
  await page.getByRole('button', { name: '撤销（Ctrl Z）', exact: true }).click();
  await page.getByRole('button', { name: '试玩 F5' }).click();
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await expect(page.locator('.player-scene-title h2')).toHaveText('测试开场');
  await page.getByRole('button', { name: '退出试玩', exact: true }).click();
  await page.getByRole('button', { name: '重做（Ctrl Shift Z）', exact: true }).click();
  await page.getByRole('button', { name: '项目设置', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '故事起点', exact: true })).toHaveCount(0);
  await expect(page.getByText('游戏开场', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '第二章 / 第二章开场', exact: true })).toHaveCount(
    0,
  );
});
