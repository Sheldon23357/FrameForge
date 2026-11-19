import { expect, type Page } from '@playwright/test';
import { testWithWorkspace as test } from './workspace-fixture';
import { testProject } from '../fixtures/project';
import { clickPlayerAction } from './player-helpers';

function fixture() {
  const p = testProject();
  p.assets.forEach((a) => {
    a.type = 'image';
    a.path = a.thumbnail!;
    a.durationMs = 0;
  });
  p.scenes[0].choicesAtMs = 0;
  const encounter = p.scenes[1];
  delete encounter.assetId;
  encounter.storyboardPages = [
    { text: '相遇的第一幕', durationMs: 1000 },
    { text: '相遇的最后一幕', durationMs: 1000 },
  ];
  return p;
}

async function boot(page: Page, p = fixture()) {
  await page.clock.install();
  await page.addInitScript(
    (project) => localStorage.setItem('frameforge.project.v1', JSON.stringify(project)),
    p,
  );
  await page.goto('/');
  await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
}

const changes = (page: Page) => page.locator('.player-stage .player-change-notice');

test('shows changes on the last frame before changing scenes and never shows the event name', async ({
  page,
}) => {
  await boot(page);
  const shell = page.locator('.player-shell');
  const dialog = page.getByRole('alertdialog');
  await page.getByRole('button', { name: /进入路线 A/ }).click();
  await expect(shell).toHaveAttribute('data-node-id', 'scene_reward');
  await expect(page.locator('.player-storyboard')).toContainText('相遇的第一幕');
  await expect(changes(page)).toHaveCount(0);
  await expect(dialog).toHaveCount(0);

  await page.clock.runFor(2400);
  await expect(shell).toHaveAttribute('data-position-ms', '2000');
  await expect(page.locator('.player-storyboard')).toContainText('相遇的最后一幕');
  await expect(changes(page)).toContainText('获得 测试道具 × 1');
  await expect(changes(page)).toContainText('现有数量 × 1');
  await expect(changes(page).getByRole('button')).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(changes(page)).toBeInViewport();

  await page.clock.runFor(1800);
  await expect(changes(page)).toContainText('信任 +15');
  await expect(changes(page)).toContainText('30 → 45');
  await expect(shell).toHaveAttribute('data-node-id', 'scene_reward');
  await expect(shell).toHaveAttribute('data-position-ms', '2000');
  await page.clock.runFor(2300);
  await expect(changes(page)).toHaveCount(0);
  await expect(shell).toHaveAttribute('data-node-id', 'scene_consume');
});

test('holds outgoing exit and automatic branch changes and shows ending changes on the ending', async ({
  page,
}) => {
  const p = fixture();
  p.items[0].initial = 1;
  p.variables.push({ id: 'flag', name: '门锁', type: 'boolean', initial: false });
  const intro = p.scenes[0];
  intro.choices[0].targetId = 'scene_branch';
  intro.events.push({
    id: 'exit_feedback',
    name: '离开森林',
    trigger: 'exit',
    once: true,
    atMs: 0,
    effects: [{ kind: 'setVariable', variableId: 'flag', value: true }],
  });
  p.scenes
    .find((scene) => scene.id === 'scene_branch')!
    .events.push({
      id: 'branch_feedback',
      name: '经过判定',
      trigger: 'enter',
      once: true,
      atMs: 0,
      effects: [{ kind: 'addVariable', variableId: 'courage', value: -2 }],
    });
  const ending = p.scenes.find((scene) => scene.id === 'scene_success')!;
  ending.events.push({
    id: 'ending_feedback',
    name: '获得奖励',
    trigger: 'enter',
    once: true,
    atMs: 0,
    effects: [{ kind: 'addVariable', variableId: 'trust', value: 5 }],
  });
  await boot(page, p);
  const shell = page.locator('.player-shell');
  await page.getByRole('button', { name: /进入路线 A/ }).click();
  await expect(changes(page)).toContainText('门锁已更新');
  await expect(changes(page)).toContainText('关闭 → 开启');
  await expect(shell).toHaveAttribute('data-node-id', 'scene_intro');
  await page.clock.runFor(1800);
  await expect(changes(page)).toContainText('勇气 -2');
  await expect(shell).toHaveAttribute('data-node-id', 'scene_intro');
  await page.clock.runFor(2750);
  await expect(shell).toHaveAttribute('data-node-id', 'scene_consume');
  await expect(changes(page)).toContainText('消耗 测试道具 × 1');
  await expect(changes(page)).toContainText('现有数量 × 0');
  await expect(page.locator('.player-storyboard')).toContainText('石门缓缓打开');

  await page.clock.runFor(2150);
  await expect(shell).toHaveAttribute('data-node-id', 'scene_success');
  await expect(changes(page)).toContainText('信任 +5');
  await page.clock.runFor(1800);
  await expect(page.locator('.player-ending')).toBeVisible();
  await expect(changes(page)).toHaveCount(0);
});

test('save and load confirmations remain available without replaying past changes', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('button', { name: /进入路线 A/ }).click();
  await page.clock.runFor(2400);
  await expect(changes(page)).toContainText('获得 测试道具 × 1');
  await page.clock.runFor(1800);
  await expect(changes(page)).toContainText('信任 +15');
  await page.clock.runFor(2300);
  await expect(page.locator('.player-shell')).toHaveAttribute('data-node-id', 'scene_consume');
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await clickPlayerAction(page, '存读档');
  await page.getByRole('button', { name: /01 空存档/ }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('进度已保存');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '读档', exact: true }).click();
  await page.getByRole('button', { name: /01 消耗节点/ }).click();
  await expect(dialog).toContainText('已恢复游戏进度');
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(changes(page)).toHaveCount(0);
});
