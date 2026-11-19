import { expect } from '@playwright/test';
import { testWithWorkspace as test } from './workspace-fixture';

test('jumps from the preview contents to the matching Markdown heading', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '剧本', exact: true }).click();
  await page.getByRole('tab', { name: '项目简报', exact: true }).click();
  const contents = page.getByRole('navigation', { name: '标题导航' });
  const reading = page.locator('.story-design-reading');
  const toolbar = page.locator('.script-toolbar');
  const tabs = toolbar.getByRole('tablist', { name: '剧本视图' });
  const modes = toolbar.getByRole('group', { name: '文档视图' });
  const edit = modes.getByRole('button', { name: '编辑', exact: true });
  const input = page.getByRole('textbox', { name: '项目简报', exact: true });
  await expect(contents).toHaveCount(0);
  await edit.click();
  const editWidth = (await input.boundingBox())!.width;
  const tabBounds = (await tabs.boundingBox())!;
  const modeBounds = (await modes.boundingBox())!;
  expect(modeBounds.x).toBeGreaterThan(tabBounds.x + tabBounds.width);
  expect(modeBounds.y + modeBounds.height).toBeLessThan((await input.boundingBox())!.y);
  const filler = '这里记录玩家可以了解的线索和采取的行动。\n\n'.repeat(45);
  await page
    .getByRole('textbox', { name: '项目简报', exact: true })
    .fill(
      '项目总览\n========\n\n## **关键线索**\n\n### 补充说明\n\n' +
        '```md\n## 代码块中的文字\n```\n\n' +
        filler +
        '## 关键线索\n\n' +
        filler,
    );
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(contents.getByRole('button')).toHaveText([
    '项目总览',
    '关键线索',
    '补充说明',
    '关键线索',
  ]);
  const wideReading = (await reading.boundingBox())!;
  expect(editWidth).toBeGreaterThan(wideReading.width);
  expect(wideReading.width).toBeGreaterThan(860);
  const availableWidth = await reading.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  expect((await reading.locator('.story-design-markdown').boundingBox())!.width).toBeCloseTo(
    availableWidth,
    0,
  );
  expect((await contents.boundingBox())!.x).toBeGreaterThanOrEqual(
    wideReading.x + wideReading.width,
  );
  await contents.getByRole('button', { name: '关键线索', exact: true }).last().press('Enter');
  const destination = reading.getByRole('heading', { name: '关键线索', exact: true }).last();
  await expect(destination).toBeFocused();
  await expect(destination).toBeInViewport();
  expect(await reading.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);

  await page.setViewportSize({ width: 900, height: 800 });
  const compactContents = (await contents.boundingBox())!;
  const compactModes = (await modes.boundingBox())!;
  const compactTabs = (await tabs.boundingBox())!;
  expect(compactModes.x).toBeGreaterThan(compactTabs.x + compactTabs.width);
  expect(compactContents.y).toBeGreaterThanOrEqual(compactModes.y + compactModes.height);
  expect((await reading.boundingBox())!.y).toBeGreaterThanOrEqual(
    compactContents.y + compactContents.height,
  );
  await contents.getByRole('button', { name: '项目总览', exact: true }).click();
  await expect(reading.getByRole('heading', { name: '项目总览', exact: true })).toBeFocused();
  await edit.press('Enter');
  await expect(edit).toBeFocused();
  await expect(input).toBeInViewport();
  await modes.getByRole('button', { name: '预览', exact: true }).press('Enter');
  await page.getByRole('tab', { name: '剧情大纲', exact: true }).click();
  await expect(contents).toHaveCount(0);
});

test('edits story design independently from the blueprint and restores it on reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.story-node')).toHaveCount(7);
  const script = page.getByRole('button', { name: '剧本', exact: true });
  await script.click();
  const tabs = page.getByRole('tablist', { name: '剧本视图' });
  await expect(tabs.getByRole('tab')).toHaveText([
    '项目简报',
    '剧情大纲',
    '分章节大纲',
    '章节剧本',
  ]);
  const tabItems = tabs.getByRole('tab');
  const tabBar = (await tabs.boundingBox())!;
  const first = (await tabItems.first().boundingBox())!;
  const last = (await tabItems.last().boundingBox())!;
  expect((first.x + last.x + last.width) / 2).toBeCloseTo(tabBar.x + tabBar.width / 2, 0);
  await expect(tabItems.first()).toHaveCSS('font-size', '17px');
  const directory = page.getByRole('navigation', { name: '章节目录' });
  const outlineLink = tabs.getByRole('tab', { name: '剧情大纲', exact: true });
  const chapterLink = tabs.getByRole('tab', { name: '分章节大纲', exact: true });
  await outlineLink.press('Home');
  const brief = page.getByRole('region', { name: '项目简报', exact: true });
  await expect(brief.getByRole('heading', { level: 1 })).toHaveCount(0);
  await expect(brief.getByText('未开始', { exact: true })).toBeVisible();
  const preview = page.getByRole('button', { name: '预览', exact: true });
  const edit = page.getByRole('button', { name: '编辑', exact: true });
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  await edit.click();
  await expect(brief.getByRole('textbox', { name: '项目简报', exact: true })).toBeVisible();
  await preview.click();
  await tabs.getByRole('tab', { name: '项目简报', exact: true }).press('ArrowRight');
  const outlineRegion = page.getByRole('region', { name: '剧情大纲', exact: true });
  await expect(outlineRegion.getByRole('heading', { level: 1 })).toHaveCount(0);
  await expect(outlineRegion.getByText('未开始', { exact: true })).toBeVisible();
  const outline = page.getByRole('textbox', { name: '剧情大纲', exact: true });
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  await expect(outline).toHaveCount(0);
  await edit.click();
  await expect(outline).toHaveCSS('font-size', '13px');
  await outline.fill('## 第一夜\n\n- 说出国王隐藏的真相。');
  await expect(page.getByText('未保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await expect(page.getByRole('heading', { name: '第一夜', exact: true })).toBeVisible();
  const paragraph = outlineRegion.locator('.story-design-markdown').getByRole('listitem');
  await expect(paragraph).toContainText('说出国王隐藏的真相。');
  await expect(paragraph).toHaveCSS('font-size', '13px');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(outline).toHaveValue('## 第一夜\n\n- 说出国王隐藏的真相。');
  await page.getByRole('button', { name: '保存并确认' }).click();
  await expect(page.getByText('已确认', { exact: true })).toBeVisible();

  await chapterLink.click();
  await expect(page.getByRole('heading', { name: '第一章 · 测试章节', level: 1 })).toBeVisible();
  await page.locator('.story-design-editor textarea').fill('先听脚步，再决定是否开门。');
  await page.getByRole('button', { name: '画布', exact: true }).click();
  await expect(page.locator('.story-node')).toHaveCount(7);
  await script.click();
  await outlineLink.click();
  await chapterLink.click();
  await expect(page.locator('.story-design-editor textarea')).toHaveValue(
    '先听脚步，再决定是否开门。',
  );
  await page.getByRole('button', { name: '保存并确认' }).click();
  await outlineLink.click();
  await outline.fill('改为从渡口开场。');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.locator('.story-design-header').getByText('草稿', { exact: true })).toHaveCount(
    0,
  );
  await chapterLink.click();
  await expect(page.getByText(/大纲已修改 · 待复核/)).toBeVisible();
  await page.getByRole('button', { name: '画布', exact: true }).click();
  await expect(page.locator('.story-node')).toHaveCount(7);
  await expect(page.getByText('已自动保存', { exact: true })).toBeVisible();

  await page.reload();
  await script.click();
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('改为从渡口开场。', { exact: true })).toBeVisible();
  await edit.click();
  await expect(outline).toHaveValue('改为从渡口开场。');
  await chapterLink.click();
  await expect(page.locator('.story-design-editor textarea')).toHaveValue(
    '先听脚步，再决定是否开门。',
  );
  await page.setViewportSize({ width: 1024, height: 720 });
  await expect(page.getByRole('button', { name: '保存并确认' })).toBeVisible();
  await page.setViewportSize({ width: 720, height: 680 });
  const scope = page.getByLabel('选择大纲章节');
  await expect(directory).toBeHidden();
  await expect(scope).toBeVisible();
  await outlineLink.click();
  await expect(outline).toHaveValue('改为从渡口开场。');
  await expect(page.getByRole('button', { name: '保存并确认' })).toBeInViewport();
});

test('renames a chapter from its outline and keeps the Markdown draft', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('已自动保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '故事大纲', exact: true }).click();
  await page.getByRole('button', { name: '新建章节', exact: true }).click();
  await page.getByLabel('章节名称', { exact: true }).fill('第二章 · 回声');
  await page.getByRole('button', { name: '创建章节', exact: true }).click();
  await page.getByRole('button', { name: '剧本', exact: true }).click();
  const chapterTab = page.getByRole('tab', { name: '分章节大纲', exact: true });
  await chapterTab.click();
  const outline = page.getByRole('region', { name: '分章节大纲' });
  const directory = outline.getByRole('navigation', { name: '章节目录' });
  await expect(directory.getByRole('button', { name: /^第二章 · 回声/ })).toBeVisible();
  await directory.getByRole('button', { name: /^第一章 · 测试章节/ }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const draft = outline.locator('textarea');
  const markdown = '# 测试开场\n\n先听脚步，再决定是否开门。';
  await draft.fill(markdown);

  const rename = outline.getByRole('button', { name: '修改标题', exact: true });
  const dialog = page.getByRole('dialog', { name: '修改章节标题' });
  const title = dialog.getByRole('textbox', { name: '章节标题' });
  const save = dialog.getByRole('button', { name: '保存标题' });
  await rename.click();
  await expect(title).toBeFocused();
  await expect(title).toHaveValue('第一章 · 测试章节');
  await title.fill('   ');
  await expect(save).toBeDisabled();
  await title.fill('第二章 · 回声');
  await save.click();
  await expect(dialog.getByRole('alert')).toHaveText('已存在同名章节。');
  await title.fill('  第一章 · 测试密语  ');
  await title.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(outline.getByRole('heading', { name: '第一章 · 测试密语' })).toBeVisible();
  await expect(directory.getByRole('button', { name: /^第一章 · 测试密语/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(draft).toHaveValue(markdown);
  await outline.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByText('已自动保存', { exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: '剧本', exact: true }).click();
  await chapterTab.click();
  await expect(outline.getByRole('heading', { name: '第一章 · 测试密语' })).toBeVisible();
  await expect(outline.getByRole('heading', { name: '测试开场' })).toBeVisible();
});

test('keeps chapter scenes and node handoff as independent text', async ({ page }) => {
  await page.goto('/');
  const chapter = page.getByRole('tab', { name: '分章节大纲', exact: true });
  const draft = page.locator('.story-design-editor textarea');
  const script = '# 第一章\n\n## 场次 1-1 窗边\n听见敲门。\n\n## 场次 1-2 门外\n有人叫我。';
  await page.getByRole('button', { name: '剧本', exact: true }).click();
  await chapter.click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await draft.fill(script);
  await page.getByRole('button', { name: '保存草稿' }).click();
  await page.getByRole('button', { name: '画布', exact: true }).click();

  await expect(page.getByLabel('来源场次', { exact: true })).toHaveCount(0);
  const openNotes = () =>
    page.locator('.inspector-tabs').getByRole('button', { name: '节点内容', exact: true }).click();
  const notes = page.getByRole('textbox', { name: '节点内容', exact: true });
  const handoff = [
    '从哪来｜本章开场。',
    '已知与持有｜窗口旁等人，手里只有一封信。',
    '这一段新增什么｜听见敲门。',
    '往哪去｜接到门外说话的节点。',
  ].join('\n');
  await openNotes();
  await notes.fill(handoff);
  await expect(page.getByText('已自动保存', { exact: true })).toBeVisible();
  await page.reload();
  await openNotes();
  await expect.poll(() => notes.innerText()).toBe(handoff);
  await page.getByRole('button', { name: '剧本', exact: true }).click();
  await chapter.click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(draft).toHaveValue(script);
});
