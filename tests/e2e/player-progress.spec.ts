import { clickPlayerAction } from './player-helpers';
import { test, expect, type Page } from './fixtures';
import fs from 'node:fs/promises';
import { testProject } from '../fixtures/project';
import { start, saveGame } from '../../packages/runtime/engine';

function fixture(hidden = false) {
  const p = testProject();
  p.assets.forEach((a) => {
    a.type = 'image';
    a.path = a.thumbnail!;
    a.durationMs = 0;
  });
  p.scenes[0].choicesAtMs = 0;
  if (hidden) {
    p.scenes[0].choices[0].hiddenWhenLocked = true;
    p.scenes[0].choices[0].condition = {
      kind: 'variable',
      variableId: 'trust',
      op: 'gte',
      value: 50,
    };
  }
  return p;
}
async function boot(page: Page, p = fixture()) {
  await page.goto('/');
  await page.getByRole('heading', { name: '创作资源', exact: true }).waitFor();
  await page.evaluate((p) => localStorage.setItem('frameforge.project.v1', JSON.stringify(p)), p);
  await page.reload();
  await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
}
async function closeModal(page: Page) {
  await page.getByRole('dialog').last().getByRole('button', { name: '关闭', exact: true }).click();
}

test('manages six slots, confirms overwrite, exports/imports and restores the original state', async ({
  page,
}) => {
  await boot(page);
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '存档', exact: true }).click();
  await expect(page.locator('.save-slot-row')).toHaveCount(7);
  await expect(page.getByLabel('存档名称（可选）')).toHaveCount(0);
  await expect(page.getByText('自动存档 + 6 个手动存档', { exact: true })).toHaveCount(0);
  const actionSize = await page
    .getByRole('button', { name: '导入到存档 01', exact: true })
    .boundingBox();
  expect(actionSize!.height).toBeGreaterThanOrEqual(44);
  expect(actionSize!.width).toBeGreaterThanOrEqual(80);
  const rows = await page.locator('.save-slot-row').evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i].x).toBe(rows[0].x);
    expect(rows[i].width).toBe(rows[0].width);
    expect(rows[i].y).toBeGreaterThanOrEqual(rows[i - 1].y + rows[i - 1].height);
  }
  await page.getByRole('button', { name: /01 空存档/ }).click();
  await page.getByRole('button', { name: /进入路线 A/ }).click();
  await clickPlayerAction(page, '运行状态');
  await expect(page.locator('.debug-value').filter({ hasText: '测试道具' })).toContainText('× 1');
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '存档', exact: true }).click();
  await page.getByRole('button', { name: /01 测试开场/ }).click();
  await expect(page.getByText('确认覆盖已有存档？', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消操作', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出存档 01', exact: true }).click();
  const file = await downloading;
  const bytes = await fs.readFile((await file.path())!);
  const exported = JSON.parse(bytes.toString());
  expect(exported.slot.title).toBe('测试开场');
  expect(exported.slot.save.state.nodeId).toBe('scene_intro');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入到存档 06', exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: bytes });
  await expect(page.getByRole('button', { name: /06 测试开场/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/player-saves.png', fullPage: true });
  await closeModal(page);
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '读档', exact: true }).click();
  await page.getByRole('button', { name: /06 测试开场/ }).click();
  await expect(page.locator('.player-scene-title h2')).toHaveText('测试开场');
  await expect(page.locator('.debug-value').filter({ hasText: '测试道具' })).toContainText('× 0');
  await expect(page.locator('.debug-value').filter({ hasText: '信任' })).toContainText('30');
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '读档', exact: true }).click();
  await page.getByRole('button', { name: '删除存档 06', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('button', { name: /06 空存档/ })).toBeDisabled();
});

test('shows damaged and incompatible saves, rejects a wrong-game import and preserves the existing slot', async ({
  page,
}) => {
  const p = fixture();
  await boot(page, p);
  const slot = { title: '旧版本', save: { ...saveGame(p, start(p)), fingerprint: 'old' } };
  await page.evaluate(
    ({ id, slot }) => {
      localStorage.setItem(`frameforge.preview.save.${id}.0`, 'broken JSON');
      localStorage.setItem(`frameforge.preview.save.${id}.1`, JSON.stringify(slot));
    },
    { id: p.id, slot },
  );
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '读档', exact: true }).click();
  await expect(page.getByRole('button', { name: /01 存档损坏/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /02 旧版本/ })).toBeDisabled();
  await expect(page.getByText('与当前作品版本不兼容', { exact: true })).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '导入到存档 01', exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: 'other.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'frameforge-save',
        version: 1,
        slot: { title: '其他游戏', save: { ...saveGame(p, start(p)), projectId: 'other' } },
      }),
    ),
  });
  await expect(page.getByRole('alert')).toContainText('不兼容');
  expect(
    await page.evaluate((id) => localStorage.getItem(`frameforge.preview.save.${id}.0`), p.id),
  ).toBe('broken JSON');
});

test('previews one step for unchosen routes and keeps secret exits hidden', async ({ page }) => {
  const p = fixture(true);
  p.chapters.push({ id: 'later', title: '第二章', startNodeId: 'scene_reward' });
  p.chapters.push({ id: 'alternate', title: '岔路章节', startNodeId: 'scene_alternate' });
  p.scenes[1].chapterId = 'later';
  p.scenes.find((scene) => scene.id === 'scene_alternate')!.chapterId = 'alternate';
  await boot(page, p);
  await expect(page.locator('.player-choice')).toHaveCount(1);
  await clickPlayerAction(page, '剧情路线');
  await expect(page.locator('.route-graph-edge.preview')).toHaveCount(1);
  const overview = page.getByRole('dialog', { name: '剧情路线', exact: true });
  for (const secret of [
    '进入路线 A',
    '奖励节点',
    '持有测试道具',
    '信任',
    '第二章',
    '结局 A',
  ])
    await expect(overview).not.toContainText(secret);
  await expect(page.locator('.route-graph-node')).toHaveCount(2);
  const preview = page.locator('.route-graph-node.preview[data-node-id="scene_alternate"]');
  await expect(preview).toContainText('未知节点');
  await expect(preview).toContainText('未知章节');
  await expect(preview).toContainText('未选择此路线');
  await expect(overview).not.toContainText('岔路章节');
  await expect(overview).not.toContainText('备选节点');
  await page.getByLabel('路线章节').selectOption(p.chapters[0].id);
  await expect(preview).toHaveClass(/external/);
  await expect(preview).toContainText('跨章');
  await expect(page.locator('path[data-source="scene_alternate"]')).toHaveCount(0);
  await expect(page.locator('.route-graph-node button')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '剧情流程图' })).toBeVisible();
  await page.screenshot({ path: 'test-results/player-routes.png', fullPage: true });
  await closeModal(page);
  await expect(page.locator('.player-scene-title h2')).toHaveText('测试开场');
  await expect(page.locator('.player-choice')).toHaveCount(1);
  await page.getByRole('button', { name: /进入路线 B/ }).click();
  await expect(page.locator('.player-scene-title h2')).toHaveText('备选节点');
  await clickPlayerAction(page, '剧情路线');
  await expect(preview).toHaveCount(0);
  await expect(page.locator('.route-graph-node.current')).toContainText('备选节点');
  await expect(page.locator('path.route-graph-edge[data-target="scene_alternate"]')).toHaveAttribute(
    'd',
    /^M .* C /,
  );
  await expect(overview).not.toContainText('剧情选择');
  await expect(overview).not.toContainText('本局已选');
});

test('preserves auto progress and exploration without playback preference or reduced-motion settings', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() =>
    localStorage.setItem(
      'frameforge.playback.preferences',
      JSON.stringify({ choices: false, transitions: false, sound: false, volume: 0.35 }),
    ),
  );
  const p = fixture();
  await boot(page, p);
  await expect(page.getByRole('button', { name: '播放偏好', exact: true })).toHaveCount(0);
  await expect(page.locator('.player-choice').first()).toHaveCSS('animation-name', 'choice-arrive');
  await page.getByRole('button', { name: /进入路线 A/ }).click();
  await expect(page.locator('.player-scene-title h2')).toHaveText('奖励节点');
  await expect(page.locator('.scene-transition')).toHaveCount(0);
  await page.getByRole('button', { name: '退出试玩', exact: true }).click();
  expect(
    await page.evaluate((id) => localStorage.getItem(`frameforge.save.${id}.auto`), p.id),
  ).toBeNull();
  await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await clickPlayerAction(page, '剧情路线');
  await expect(page.locator('.route-graph-node.visited')).toHaveCount(1);
  await expect(page.locator('.route-graph-edge:not(.preview)')).toHaveCount(0);
  await closeModal(page);
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '读档', exact: true }).click();
  await page.getByRole('button', { name: /AUTO 自动存档 · 奖励节点/ }).click();
  await expect(page.locator('.player-scene-title h2')).toHaveText('奖励节点');
  await clickPlayerAction(page, '剧情路线');
  await expect(
    page.locator('path.route-graph-edge[data-target="scene_reward"]').first(),
  ).toHaveAttribute('d', /^M .* C /);
  await closeModal(page);
  await expect(page.getByRole('button', { name: '播放偏好', exact: true })).toHaveCount(0);
});

test('restores the exact trimmed video position without replaying entry effects', async ({
  page,
}) => {
  const p = testProject();
  p.scenes[0].choicesAtMs = 0;
  p.scenes[1].trimStartMs = 1000;
  await boot(page, p);
  await page.getByRole('button', { name: /进入路线 A/ }).click();
  // Explicitly finish the new confirmation queue before sampling media time (poll/evaluate aren't user actions).
  await expect(page.locator('.player-shell')).toHaveAttribute('data-node-id', 'scene_reward');
  await expect(page.locator('.scene-transition')).toHaveCount(0);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  const video = page.locator('.player-stage video');
  await expect(video).toHaveJSProperty('readyState', 4);
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 3.5;
  });
  await expect
    .poll(async () => Number(await page.locator('.player-shell').getAttribute('data-position-ms')))
    .toBeGreaterThanOrEqual(2400);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '存档', exact: true }).click();
  await page.getByRole('button', { name: /01 空存档/ }).click();
  const saved = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`frameforge.preview.save.${id}.0`)!),
    p.id,
  );
  expect(saved.save.state.positionMs).toBeGreaterThanOrEqual(2400);
  expect(saved.save.state.positionMs).toBeLessThan(3100);
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 6;
  });
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '读档', exact: true }).click();
  await page.getByRole('button', { name: /01 奖励节点/ }).click();
  await expect(video).toHaveJSProperty('readyState', 4);
  const time = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  expect(time).toBeGreaterThanOrEqual(3.4);
  expect(time).toBeLessThan(4.4);
  await clickPlayerAction(page, '运行状态');
  await expect(page.locator('.debug-value').filter({ hasText: '测试道具' })).toContainText('× 1');
  await expect(page.locator('.debug-value').filter({ hasText: '信任' })).toContainText('45');
});

test('persists an accepted choice when exiting during the fade-out', async ({ page }) => {
  const p = fixture();
  await boot(page, p);
  await page.clock.install({ time: new Date('2026-11-10T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-10T00:00:01Z'));
  await page.getByRole('button', { name: /进入路线 A/ }).click();
  await expect(page.locator('.scene-transition.out')).toHaveCount(1);
  await page.getByRole('button', { name: '退出试玩', exact: true }).click();
  const saved = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`frameforge.preview.save.${id}.auto`)!),
    p.id,
  );
  expect(saved.save.state.nodeId).toBe('scene_reward');
  expect(saved.save.state.inventory.leaf).toBe(1);
  expect(saved.save.state.takenChoices).toContain('choice_explore');
});
