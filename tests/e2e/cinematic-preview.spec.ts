import { clickPlayerAction } from './player-helpers';
import { test, expect } from './fixtures';

test('preview fills the window and uses the same floating menu as the released player', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
  await expect(page.locator('.player-header')).toHaveCount(0);
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(await page.locator('.player-stage').boundingBox()).toEqual({ x: 0, y: 0, ...dimensions });
  await expect(page.locator('.player-stage video')).toHaveCSS('object-fit', 'cover');
  await expect(page.locator('#player-menu')).toBeHidden();
  await expect(page.getByRole('button', { name: '退出试玩', exact: true })).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#player-menu')).toBeVisible();
  await expect(page.getByRole('button', { name: '播放偏好', exact: true })).toHaveCount(0);
  await expect(page.getByText('减少动态效果', { exact: true })).toHaveCount(0);
  await clickPlayerAction(page, '运行状态');
  await expect(page.locator('.runtime-debug')).toBeVisible();
  expect(await page.locator('.player-stage').boundingBox()).toEqual({ x: 0, y: 0, ...dimensions });
  await clickPlayerAction(page, '运行状态');
  await page.screenshot({ path: '.local/cinematic-preview.png', fullPage: true });
  await expect(page.getByRole('button', { name: '静音', exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: '游戏主要操作' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#player-menu')).toBeHidden();
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await page.getByRole('button', { name: '退出试玩', exact: true }).click();
  await expect(page.locator('.player-shell')).toHaveCount(0);
});

test('route overview is a flowchart with navigation, preserves the current game and supports chapter filtering', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await clickPlayerAction(page, '剧情路线');
  const graph = page.getByRole('region', { name: '剧情流程图', exact: true });
  await expect(graph).toBeVisible();
  await expect(page.locator('.route-graph-node')).toHaveCount(1);
  await expect(page.locator('.route-graph-edge')).toHaveCount(0);
  await expect(page.locator('.route-graph-node button')).toHaveCount(0);
  const before = await page.locator('.route-graph-world').getAttribute('style');
  await page.getByRole('button', { name: '放大路线图', exact: true }).click();
  await expect(page.locator('.route-graph-world')).not.toHaveAttribute('style', before!);
  const bounds = (await graph.boundingBox())!;
  const original = await page.locator('.route-graph-world').getAttribute('style');
  await page.mouse.move(bounds.x + 30, bounds.y + 30);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 100, bounds.y + 85);
  await page.mouse.up();
  await expect(page.locator('.route-graph-world')).not.toHaveAttribute('style', original!);
  await page.getByRole('button', { name: '适应路线图', exact: true }).click();
  await page.getByLabel('路线章节').selectOption({ label: '第一章 · 测试章节' });
  await expect(page.locator('.route-graph-node')).toHaveCount(1);
  await page.screenshot({ path: '.local/route-flowchart.png', fullPage: true });
  await page.getByRole('button', { name: '定位当前节点', exact: true }).click();
  await expect(page.locator('.route-graph-node.current')).toBeInViewport();
  await page
    .getByRole('dialog', { name: '剧情路线', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await expect(page.locator('.player-scene-title h2')).toHaveText('测试开场');
});
