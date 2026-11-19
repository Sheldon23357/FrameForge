import { test, expect } from './fixtures';
import { testProject } from '../fixtures/project';
import { clickPlayerAction } from './player-helpers';

test('hidden attribute setting supports undo, persists, and hides live values while story rules keep working', async ({
  page,
}) => {
  const project = testProject();
  project.scenes[0].choicesAtMs = 0;
  project.assets.forEach((asset) => {
    asset.type = 'image';
    asset.path = asset.thumbnail!;
    asset.durationMs = 0;
  });
  await page.goto('/');
  await page.getByRole('heading', { name: '创作资源', exact: true }).waitFor();
  await page.evaluate(
    (p) => localStorage.setItem('frameforge.project.v1', JSON.stringify(p)),
    project,
  );
  await page.reload();
  await page.getByRole('button', { name: '参数', exact: true }).click();
  const card = page
    .locator('.definition-card')
    .filter({ has: page.locator('code').filter({ hasText: /^trust$/ }) });
  const hidden = card.getByRole('switch', { name: '隐藏属性', exact: true });
  await expect(hidden).not.toBeChecked();
  await hidden.check();
  const fieldBox = (await card.getByLabel('比较值', { exact: true }).boundingBox())!;
  const toggleBox = (await hidden.boundingBox())!;
  expect(
    Math.abs(fieldBox.y + fieldBox.height / 2 - toggleBox.y - toggleBox.height / 2),
  ).toBeLessThan(2);
  await expect(card.getByText('在玩家属性面板中隐藏', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '撤销（Ctrl Z）', exact: true }).click();
  await expect(hidden).not.toBeChecked();
  await page.getByRole('button', { name: '重做（Ctrl Shift Z）', exact: true }).click();
  await expect(hidden).toBeChecked();
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.screenshot({ path: '.local/previews/hidden-attribute-setting.png' });
  await page.reload();
  await page.getByRole('button', { name: '参数', exact: true }).click();
  await expect(hidden).toBeChecked();
  await page.getByRole('button', { name: /^试玩(?: F5)?$/ }).click();
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await clickPlayerAction(page, '查看属性');
  const attributes = page.getByRole('dialog', { name: '属性', exact: true });
  await expect(attributes).toContainText('勇气');
  await expect(attributes).not.toContainText('信任');
  await attributes.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: /进入路线 A/ }).click();
  await expect(page.locator('.player-shell')).toHaveAttribute('data-node-id', 'scene_reward');
  await clickPlayerAction(page, '查看属性');
  await expect(attributes).not.toContainText('信任');
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          JSON.parse(localStorage.getItem(`frameforge.preview.save.${id}.auto`)!).save.state
            .variables.trust,
        project.id,
      ),
    )
    .toBe(45);
  await page.screenshot({ path: '.local/previews/hidden-attribute-player.png' });
});

test('all hidden attributes show an empty panel in portrait without deleting runtime values', async ({
  page,
}) => {
  const project = testProject();
  project.variables.forEach((variable) => {
    variable.hidden = true;
  });
  project.assets.forEach((asset) => {
    asset.type = 'image';
    asset.path = asset.thumbnail!;
    asset.durationMs = 0;
  });
  await page.goto('/');
  await page.getByRole('heading', { name: '创作资源', exact: true }).waitFor();
  await page.evaluate(
    (p) => localStorage.setItem('frameforge.project.v1', JSON.stringify(p)),
    project,
  );
  await page.reload();
  await page.getByRole('button', { name: /^试玩(?: F5)?$/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await clickPlayerAction(page, '查看属性');
  const attributes = page.getByRole('dialog', { name: '属性', exact: true });
  await expect(attributes).toContainText('暂无属性');
  await expect(attributes).not.toContainText('信任');
  await expect(attributes).not.toContainText('勇气');
  await expect(page.locator('.player-attributes')).toHaveCount(0);
});
