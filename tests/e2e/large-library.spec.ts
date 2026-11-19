import { test, expect } from './fixtures';
import { testProject } from '../fixtures/project';

test('a large library loads nearby thumbnails and keeps distant assets usable', async ({
  page,
}) => {
  const project = testProject();
  const template = project.assets[0];
  while (project.assets.length < 480) {
    const index = project.assets.length;
    project.assets.push({ ...template, id: `large-${index}`, name: `分镜 ${index}` });
  }
  project.assets.forEach((asset, index) => {
    asset.thumbnail = `${asset.thumbnail}?large-library=${index}`;
  });
  await page.addInitScript(
    (p) => localStorage.setItem('frameforge.project.v1', JSON.stringify(p)),
    project,
  );
  const requests = new Set<string>();
  page.on('request', (request) => {
    if (request.url().includes('?large-library=')) requests.add(request.url());
  });
  await page.goto('/');
  await expect(page.locator('.asset-card')).toHaveCount(480);
  await expect(page.locator('.asset-thumbnail img').first()).toHaveJSProperty('naturalWidth', 640);
  await page.waitForLoadState('networkidle');
  expect(requests.size).toBeLessThan(120);

  await page.locator('.asset-list').evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await expect(page.locator('.asset-thumbnail img').last()).toHaveJSProperty('naturalWidth', 640);
  await page.getByRole('textbox', { name: '搜索创作资源' }).fill('分镜 479');
  await expect(page.locator('.asset-card')).toHaveCount(1);
  await page.locator('.asset-card').dblclick();
  await expect(page.locator('.story-node')).toHaveCount(project.scenes.length + 1);
  await expect(page.locator('.story-node.selected img')).toHaveJSProperty('naturalWidth', 640);
});
