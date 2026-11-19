import { expect } from '@playwright/test';
import { testWithWorkspace as test } from './workspace-fixture';

test('dropping a library asset on a poster binds it, supports undo, and does not create a node', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.story-node')).toHaveCount(7);
  const poster = page.locator('.react-flow__node[data-id="scene_intro"] .node-poster');
  await page.locator('.asset-card').nth(2).dragTo(poster);
  const preview = page.locator('.inspector-preview img');
  await expect(preview).toHaveAttribute('src', /tertiary\.jpg/);
  await expect(page.getByText('绑定素材', { exact: true })).toHaveCount(0);
  await expect(page.locator('.story-node')).toHaveCount(7);
  await expect(poster.locator('img')).toHaveAttribute('src', /tertiary\.jpg/);
  await expect(page.locator('.blueprint')).not.toHaveClass(/asset-dragging/);
  await page.keyboard.press('Control+z');
  await expect(preview).toHaveAttribute('src', /primary\.jpg/);
  await expect(page.locator('.story-node')).toHaveCount(7);
});
