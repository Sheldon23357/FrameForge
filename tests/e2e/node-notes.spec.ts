import { test, expect } from './fixtures';

test('edits private notes in the fourth inspector tab and displays only the ending summary', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.story-node')).toHaveCount(7);
  await expect(page.getByLabel('剧情描述', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('节点内容')).not.toBeVisible();
  const tabs = page.locator('.inspector-tabs').getByRole('button');
  await expect(tabs).toHaveText(['属性', '选项2', '事件0', '节点内容']);
  await tabs.last().press('Enter');
  const notesPanel = page.locator('.node-notes-panel');
  const notes = notesPanel.getByRole('textbox', { name: '节点内容' });
  await expect(notes).toBeVisible();
  await expect(notesPanel.locator('textarea')).toHaveCount(0);
  await expect(notes).toHaveCSS('font-size', '11px');
  await expect(notes).toHaveCSS('color', 'rgb(184, 184, 184)');
  const fullNotes = '仅作者可见的备注 A-714\n第二段视频描述';
  await notes.fill(fullNotes);
  await tabs.first().click();
  await expect(notes).toHaveCount(0);
  await tabs.last().click();
  await expect.poll(() => notes.innerText()).toBe(fullNotes);
  await expect(page.locator('.react-flow__node[data-id="scene_intro"]')).not.toContainText(
    '仅作者可见',
  );
  await page.getByRole('button', { name: '试玩 F5' }).click();
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await expect(page.locator('.player-subtitle')).toHaveCount(0);
  await expect(page.locator('.player-shell')).not.toContainText('仅作者可见');
  await page.getByRole('button', { name: '退出试玩' }).click();
  await page.locator('.react-flow__node[data-id="scene_success"] .node-body h3').click();
  await page
    .getByRole('textbox', { name: '结局总结', exact: true })
    .fill('玩家可见的独立结局文案 E-211');
  await tabs.last().click();
  await expect(notes).toHaveText('');
  await page.getByLabel('节点内容').fill('结局内部备注 N-391');
  await page.getByRole('button', { name: '从此节点试玩', exact: true }).last().click();
  await expect(page.locator('.player-ending')).toContainText('玩家可见的独立结局文案 E-211');
  await expect(page.locator('.player-shell')).not.toContainText('结局内部备注 N-391');
});
