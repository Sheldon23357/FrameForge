import { test, expect } from './fixtures';

test('shows grouped summaries, persists history on reload and recovers the pre-rollback version', async ({
  page,
}) => {
  await page.goto('/');
  const name = page.getByLabel('节点名称', { exact: true });
  const title = page.locator('.inspector-scene-title h2');
  const edit = page.getByRole('button', { name: '编辑节点名称', exact: true });
  await edit.click();
  await expect(name).toHaveValue('测试开场');
  await name.fill('开场初稿');
  await name.blur();
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await edit.click();
  await name.fill('开场定稿');
  await name.blur();
  await expect(page.locator('.save-indicator')).toContainText('已自动保存');
  await page.reload();
  await expect(title).toHaveText('开场定稿');

  const history = page.getByRole('button', { name: '修改历史', exact: true });
  const dialog = page.getByRole('dialog', { name: '修改历史', exact: true });
  await history.click();
  await expect(dialog.getByRole('button', { name: /修改节点名称.*开场定稿/ })).toContainText(
    '当前版本',
  );
  await dialog.getByRole('button', { name: /修改节点名称.*开场初稿/ }).click();
  await expect(dialog.getByRole('region', { name: '版本改动' })).toContainText('开场初稿');
  await dialog.getByRole('button', { name: '回退到此版本', exact: true }).click();
  await dialog.getByRole('button', { name: '确认回退', exact: true }).click();
  await expect(title).toHaveText('开场初稿');

  await history.click();
  await expect(dialog.getByRole('button', { name: /回退到.*开场初稿/ })).toContainText('当前版本');
  await dialog.getByRole('button', { name: /修改节点名称.*开场定稿/ }).click();
  await dialog.getByRole('button', { name: '回退到此版本', exact: true }).click();
  await dialog.getByRole('button', { name: '确认回退', exact: true }).click();
  await expect(title).toHaveText('开场定稿');

  await page.setViewportSize({ width: 760, height: 840 });
  await expect(history).toBeInViewport();
  await history.click();
  await expect(dialog).toBeVisible();
});
