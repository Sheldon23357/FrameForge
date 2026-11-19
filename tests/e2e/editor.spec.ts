import { clickPlayerAction } from './player-helpers';
import { test, expect } from './fixtures';
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '创作资源' })).toBeVisible();
});

test.describe('first launch', () => {
  test.use({ seedProject: false });
  test('opens a blank project and creates another through the menu', async ({ page }) => {
  await expect(page.getByRole('button', { name: '未命名作品', exact: true })).toBeVisible();
  await expect(page.locator('.story-node')).toHaveCount(1);
  await expect(page.locator('.asset-card')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '主导航' })).not.toContainText('新建作品');
  await expect(page.getByRole('button', { name: '新建作品', exact: true })).toHaveCount(0);
  await page.locator('.project-menu').click();
  await page.getByRole('menuitem', { name: '新建作品', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建作品', exact: true });
  await dialog.getByRole('textbox').fill('新的互动影游');
  await dialog.getByRole('button', { name: '创建工程', exact: true }).click();
  await expect(page.getByRole('button', { name: '新的互动影游', exact: true })).toBeVisible();
  await expect(page.locator('.story-node')).toHaveCount(1);
  await expect(page.locator('.asset-card')).toHaveCount(0);
  });
});
test('loads a clean blueprint and renders offline video thumbnails', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.locator('.story-node')).toHaveCount(7);
  await expect(page.getByRole('button', { name: '工程检查通过' })).toBeVisible();
  await expect(page.locator('.asset-thumbnail img').first()).toHaveJSProperty('naturalWidth', 640);
  await page.screenshot({ path: 'test-results/studio-blueprint.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('edits a scene, undoes and redoes changes, duplicates a node', async ({ page }) => {
  const title = page.locator('.inspector-scene-title h2');
  const edit = page.getByRole('button', { name: '编辑节点名称', exact: true });
  const input = page.getByLabel('节点名称', { exact: true });
  await expect(input).toHaveCount(0);
  await edit.press('Enter');
  await expect(input).toBeFocused();
  await input.fill('新的开场');
  await expect(page.locator('.story-node.selected h3')).toHaveText('新的开场');
  await input.press('Enter');
  await expect(edit).toBeFocused();
  await expect(title).toHaveText('新的开场');
  await page.keyboard.press('Control+z');
  await expect(title).toHaveText('测试开场');
  await page.keyboard.press('Control+Shift+z');
  await expect(title).toHaveText('新的开场');
  await page.getByRole('button', { name: '复制节点', exact: true }).click();
  await expect(page.locator('.story-node')).toHaveCount(8);
  await expect(title).toHaveText('新的开场 副本');
});
test('plays a branching story, saves and restores without granting an item twice', async ({
  page,
}) => {
  await page.getByRole('button', { name: '试玩 F5' }).click();
  await page.getByRole('button', { name: /进入路线 A/ }).click();
  await clickPlayerAction(page, '运行状态');
  await expect(page.locator('.debug-value').filter({ hasText: '测试道具' })).toContainText('× 1');
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '存档', exact: true }).click();
  await page.getByRole('button', { name: /01 空存档/ }).click();
  await expect(page.locator('.player-ending h2')).toContainText('结局 A', {
    timeout: 20000,
  });
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '读档', exact: true }).click();
  await page.getByRole('button', { name: /01 奖励节点/ }).click();
  await expect(page.locator('.debug-value').filter({ hasText: '测试道具' })).toContainText('× 1');
  await expect(page.locator('.debug-value').filter({ hasText: '信任' })).toContainText('45');
});
test('creates attributes and items and configures nested conditions', async ({ page }) => {
  await page.getByRole('button', { name: '参数', exact: true }).click();
  await expect(page.getByRole('button', { name: /^属性参数\s*\d+$/ })).toBeVisible();
  await page.getByRole('button', { name: '添加属性', exact: true }).click();
  await page.getByLabel('显示名称').last().fill('线索数量');
  await page.getByRole('button', { name: /^道具\s*\d+$/ }).click();
  await page.getByRole('button', { name: '添加道具', exact: true }).click();
  await page.getByLabel('道具名称').last().fill('铜钥匙');
  await page.getByRole('button', { name: '画布', exact: true }).click();
  await page.getByRole('button', { name: /选项\s*2/ }).click();
  const choice = page.locator('.choice-editor').first();
  const pencil = choice.getByRole('button', { name: '编辑选项文案' });
  await expect(choice.getByRole('textbox', { name: '选项文案' })).toHaveCount(0);
  await pencil.press('Enter');
  const title = choice.getByRole('textbox', { name: '选项文案' });
  await title.fill('沿声寻踪');
  await title.press('Enter');
  await expect(pencil).toBeFocused();
  await expect(choice.locator('summary')).toContainText('沿声寻踪');
  await expect(choice).not.toHaveAttribute('open', '');
  await page.locator('.choice-editor summary').first().click();
  await expect(page.getByText('选择后的效果', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '添加子条件' }).first().click();
  await page.setViewportSize({ width: 900, height: 800 });
  await page.getByRole('separator', { name: '调整检查器宽度' }).press('ArrowRight');
  const condition = page.locator('.condition-child').first();
  const type = condition.getByLabel('条件类型');
  const attribute = condition.getByLabel('判定属性');
  const operator = condition.getByLabel('比较方式');
  const value = condition.getByLabel('比较值');
  await operator.selectOption('lte');
  await value.fill('20');
  const typeBox = (await type.boundingBox())!;
  const attributeBox = (await attribute.boundingBox())!;
  const operatorBox = (await operator.boundingBox())!;
  const valueBox = (await value.boundingBox())!;
  expect(attributeBox.y).toBeGreaterThanOrEqual(typeBox.y + typeBox.height);
  expect(operatorBox.y).toBeGreaterThanOrEqual(attributeBox.y + attributeBox.height);
  expect(valueBox.y).toBe(operatorBox.y);
  expect(valueBox.x).toBeGreaterThan(operatorBox.x + operatorBox.width);
  expect(valueBox.x + valueBox.width).toBeLessThanOrEqual(attributeBox.x + attributeBox.width);
  await expect(value).toHaveValue('20');
  await page.screenshot({ path: 'test-results/rule-inspector.png', fullPage: true });
});
test('persists editing across a reload and downloads a portable project with media', async ({
  page,
}) => {
  await page.getByRole('button', { name: '编辑节点名称', exact: true }).click();
  await page.getByLabel('节点名称', { exact: true }).fill('自动保存的节点');
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await expect(page.locator('.inspector-scene-title h2')).toHaveText('自动保存的节点');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '保存工程（Ctrl S）' }).click();
  const result = await download;
  expect(result.suggestedFilename()).toBe('测试工程.frameforge.zip');
});

test('searches the blueprint and deletes a selected connection without deleting a scene', async ({
  page,
}) => {
  const search = page.getByRole('textbox', { name: '搜索蓝图节点' });
  await search.fill('道具');
  await expect(search).toHaveValue('道具');
  await expect(page.locator('.react-flow__node.search-dimmed')).toHaveCount(5);
  await search.fill('');
  await search.blur();
  const edge = page.locator('.react-flow__edge').first();
  await edge.click();
  await expect(edge).toHaveClass(/selected/);
  await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__edge')).toHaveCount(7);
  await expect(page.locator('.story-node')).toHaveCount(7);
  await expect(page.locator('.app-statusbar')).toContainText('1 个问题');
});
