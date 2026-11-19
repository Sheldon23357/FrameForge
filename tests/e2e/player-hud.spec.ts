import { test, expect, type Page } from './fixtures';
import { testProject } from '../fixtures/project';
async function boot(page: Page, cue = 0) {
  const p = testProject();
  p.scenes[0].choicesAtMs = cue;
  p.assets.forEach((a) => {
    a.type = 'image';
    a.path = a.thumbnail!;
    a.durationMs = 0;
  });
  await page.goto('/');
  await page.getByRole('heading', { name: '创作资源', exact: true }).waitFor();
  await page.evaluate((p) => localStorage.setItem('frameforge.project.v1', JSON.stringify(p)), p);
  await page.reload();
  await page.getByRole('button', { name: /^试玩(?: F5)?$/ }).click();
}
async function tapScreen(page: Page) {
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
}
async function close(page: Page, title: string) {
  await page
    .getByRole('dialog', { name: title, exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
}

test('keeps preview playback controls in the corners and puts save and restart in the menu', async ({
  page,
}) => {
  await boot(page);
  await expect(page.getByRole('button', { name: '菜单', exact: true })).toBeVisible();
  await tapScreen(page);
  const size = page.viewportSize()!;
  let previous = 0;
  for (const label of ['播放', '退出试玩']) {
    const button = page.getByRole('button', { name: label, exact: true });
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThan(size.width / 2);
    expect(box.y).toBeLessThan(size.height / 2);
    expect(box.x).toBeGreaterThan(previous);
    previous = box.x;
    expect(box.height).toBeGreaterThanOrEqual(56);
  }
  for (const label of ['查看属性', '查看道具']) {
    const box = (await page.getByRole('button', { name: label, exact: true }).boundingBox())!;
    expect(box.x).toBeLessThan(size.width / 2);
    expect(box.y).toBeGreaterThan(size.height / 2);
  }
  const menu = (await page.getByRole('button', { name: '菜单', exact: true }).boundingBox())!;
  expect(menu.x).toBeGreaterThan(size.width / 2);
  expect(menu.y).toBeGreaterThan(size.height / 2);
  for (const label of ['存读档', '重新开始'])
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '剧情路线', exact: true })).toHaveCount(0);
  await expect(page.locator('.player-playback-actions')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '跳至交互', exact: true })).toHaveCount(0);
  await expect(page.locator('.player-choice').first()).toHaveCSS(
    'background-color',
    'rgba(24, 24, 24, 0.5)',
  );
  await page.screenshot({ path: '.local/previews/player-hud-corners.png' });
  await page.getByRole('button', { name: '菜单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '游戏菜单', exact: true });
  await expect(dialog.getByRole('button', { name: '存读档', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '重新开始', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '重新开始游戏？' })).toBeVisible();
});

test('keeps attributes and inventory available in the lower left and reflects real story changes', async ({
  page,
}) => {
  await boot(page);
  await tapScreen(page);
  await page.getByRole('button', { name: '查看属性', exact: true }).click();
  await expect(page.locator('.player-attributes > div').filter({ hasText: '信任' })).toContainText(
    '30',
  );
  await close(page, '属性');
  await page.getByRole('button', { name: /进入路线 A/ }).click();
  await page.getByRole('button', { name: '查看属性', exact: true }).click();
  await expect(page.locator('.player-attributes > div').filter({ hasText: '信任' })).toContainText(
    '45',
  );
  await close(page, '属性');
  await page.getByRole('button', { name: '查看道具', exact: true }).click();
  await expect(page.locator('.player-inventory')).toContainText('测试道具');
  await expect(page.locator('.player-inventory')).toContainText('× 1');
  await close(page, '道具');
  // The encounter plays for nine seconds, then shows each change before the ending.
  await expect(page.locator('.player-ending h2')).toContainText('结局 A', { timeout: 18000 });
  await page.getByRole('button', { name: '查看道具', exact: true }).click();
  await expect(page.getByText('背包为空', { exact: true })).toBeVisible();
});

test('portrait keeps only playback actions at the top and opens secondary actions from the menu', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, 8000);
  await tapScreen(page);
  const top = page.getByRole('region', { name: '游戏顶部菜单', exact: true });
  await expect(top.getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '跳至交互', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /进入路线 A/ })).toHaveCount(0);
  for (const label of ['播放', '菜单']) {
    const button = page.getByRole('button', { name: label, exact: true });
    await expect(button).toBeInViewport();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const secondary = ['存读档', '查看属性', '查看道具', '重新开始', '退出试玩'];
  for (const label of secondary)
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  await page.screenshot({ path: '.local/previews/player-hud-portrait.png' });
  await page.getByRole('button', { name: '菜单', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '游戏菜单', exact: true });
  for (const label of [
    ...secondary,
    '剧情路线',
    '全屏画面',
    '作品信息',
    '测试初始值',
    '运行状态',
  ]) {
    const item = menu.getByRole('button', { name: label, exact: true });
    await expect(item).toBeVisible();
    await expect(item.locator('small')).not.toBeEmpty();
  }
  for (const label of ['暂停', '播放', '跳至交互'])
    await expect(menu.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  await page.screenshot({ path: '.local/previews/player-more-menu.png' });
  await menu.getByRole('button', { name: '存读档', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '存读档', exact: true }).getByRole('tab'),
  ).toHaveCount(2);
  await close(page, '存读档');
  await page.getByRole('button', { name: '菜单', exact: true }).click();
  await menu.getByRole('button', { name: '作品信息', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.player-about')).toContainText('测试工程');
  await close(page, '作品信息');
  await tapScreen(page);
  await expect(page.getByRole('button', { name: /进入路线 A/ })).toBeVisible({
    timeout: 12000,
  });
});

test('both game menus pause the scene and preserve manual pause when dismissed', async ({
  page,
}) => {
  await boot(page, 8000);
  const shell = page.locator('.player-shell');
  const position = async () => Number(await shell.getAttribute('data-position-ms'));
  await expect.poll(position).toBeGreaterThan(100);
  await tapScreen(page);
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  const hudPosition = await position();
  await page.waitForTimeout(300);
  expect(await position()).toBe(hudPosition);
  await tapScreen(page);
  await expect.poll(position).toBeGreaterThan(hudPosition);
  const entry = page.getByRole('button', { name: '菜单', exact: true });
  const menu = page.getByRole('dialog', { name: '游戏菜单', exact: true });
  await entry.click();
  await expect(menu).toBeVisible();
  const menuPosition = await position();
  await page.waitForTimeout(300);
  expect(await position()).toBe(menuPosition);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(entry).toBeFocused();
  await expect.poll(position).toBeGreaterThan(menuPosition);
  await tapScreen(page);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await entry.click();
  await page.locator('.dialog-overlay').click({ position: { x: 2, y: 2 } });
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  await tapScreen(page);
  const manuallyPausedPosition = await position();
  await page.waitForTimeout(300);
  expect(await position()).toBe(manuallyPausedPosition);
  await tapScreen(page);
  await page.getByRole('button', { name: '退出试玩', exact: true }).click();
  await expect(page.locator('.player-shell')).toHaveCount(0);
});
