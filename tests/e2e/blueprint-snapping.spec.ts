import { expect } from '@playwright/test';
import { testWithWorkspace as test } from './workspace-fixture';
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.story-node')).toHaveCount(7);
});
test('aligns dragged nodes, shows guides and preserves the snapped position', async ({ page }) => {
  const source = page.locator('.react-flow__node[data-id="scene_intro"]');
  const peer = page.locator('.react-flow__node[data-id="scene_reward"]');
  const from = (await source.boundingBox())!;
  const to = (await peer.boundingBox())!;
  const zoom = from.width / 254;
  await page.mouse.move(from.x + from.width / 2, from.y + 12 * zoom);
  await page.mouse.down();
  await page.mouse.move(to.x + from.width / 2 + 5 * zoom, from.y + 12 * zoom + 50, { steps: 18 });
  await expect(page.locator('.alignment-guides line')).not.toHaveCount(0);
  await page.mouse.up();
  await expect(source).toHaveCSS('transform', /matrix\(1, 0, 0, 1, 420,/);
  await expect(page.locator('.alignment-guides line')).toHaveCount(0);
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await expect(source).toHaveCSS('transform', /matrix\(1, 0, 0, 1, 420,/);
  const toggle = page.getByRole('button', { name: '自动吸附', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});
test('connects by releasing close to an input port and renders thicker rounded curves', async ({
  page,
}) => {
  const source = page.locator(
    '.react-flow__node[data-id="scene_intro"] .react-flow__handle[data-handleid="choice_explore"]',
  );
  const target = page.locator('.react-flow__node[data-id="scene_neutral"] .react-flow__handle-left');
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  const nodeWidth = await page
    .locator('.react-flow__node[data-id="scene_neutral"]')
    .evaluate((e) => e.getBoundingClientRect().width);
  const zoom = nodeWidth / 254;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2 - 30 * zoom, to.y + to.height / 2, { steps: 22 });
  await page.mouse.up();
  const edge = page.locator('.react-flow__edge[data-id="choice_explore"]');
  await expect(edge).toHaveAttribute('aria-label', /scene_neutral/);
  await expect(edge.locator('.react-flow__edge-path')).toHaveCSS('stroke-width', '3px');
  await expect(edge.locator('.react-flow__edge-path')).toHaveCSS('stroke-linecap', 'round');
});
