import { createEditorTools } from '../../packages/agent/tools';
import { testProject } from '../fixtures/project';
import { test, expect } from './fixtures';

test('filters mixed assets by category and name in both views', async ({ page }) => {
  const project = testProject();
  const videoCount = project.assets.length;
  const template = project.assets[0];
  const image = { ...template, type: 'image' as const, path: template.thumbnail!, durationMs: 0 };
  project.assets.push(
    { ...image, id: 'still', name: '雪团剧照.jpg' },
    { ...image, id: 'linked', name: '角色立绘.jpg' },
    { ...image, id: 'generated', name: '雪团 · 定妆参考图.png' },
    { ...template, id: 'music', name: '主题曲.wav', type: 'audio', thumbnail: undefined },
    { ...template, id: 'voice', name: '角色干声.wav', type: 'audio', thumbnail: undefined },
  );
  project.worldSettings = [
    { id: 'character', kind: 'character', name: '雪团', imageAssetId: 'linked' },
  ];

  const registry = createEditorTools();
  const context = { project, selectedIds: [], activeChapterId: null, intents: [] };
  const result = registry.execute(
    'read_project',
    JSON.stringify({ action: 'assets', category: 'reference', query: '雪团' }),
    context,
  );
  expect(result.data).toMatchObject({ total: 1, assets: [{ id: 'generated', type: 'image' }] });
  expect(
    registry.execute('read_project', '{"action":"assets","type":"image"}', context).data,
  ).toMatchObject({ total: 3 });

  await page.addInitScript(
    (p) => localStorage.setItem('frameforge.project.v1', JSON.stringify(p)),
    project,
  );
  await page.goto('/');
  const categories = page.getByRole('group', { name: '素材分类' });
  const category = (name: string) => categories.getByRole('button', { name, exact: true });
  const cards = page.locator('.asset-card');
  await expect(category('全部')).toHaveAttribute('aria-pressed', 'true');
  await expect(cards).toHaveCount(project.assets.length);
  await category('视频').click();
  await expect(cards).toHaveCount(videoCount);
  await category('图片').click();
  await expect(cards).toHaveText(/雪团剧照/);
  await category('音乐').click();
  await expect(cards).toHaveText(/主题曲/);
  await category('语音').click();
  await expect(cards).toHaveText(/角色干声/);
  await category('设定图').press('Enter');
  await expect(category('设定图')).toHaveAttribute('aria-pressed', 'true');
  await expect(cards).toHaveCount(2);
  const search = page.getByRole('textbox', { name: '搜索创作资源' });
  await search.fill('雪团');
  await expect(cards).toHaveText(/定妆参考图/);
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  await expect(page.locator('.asset-list.compact .asset-card')).toHaveText(/定妆参考图/);
  await category('视频').click();
  await expect(page.getByText('无匹配素材')).toBeVisible();
  await category('全部').click();
  await expect(cards).toHaveCount(2);

  const resize = page.getByRole('separator', { name: '调整创作资源面板宽度' });
  for (let i = 0; i < 3; i++) await resize.press('ArrowLeft');
  await expect(resize).toHaveAttribute('aria-valuenow', '190');
  await page.reload();
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(resize).toHaveAttribute('aria-valuenow', '190');
  await category('设定图').click();
  await expect(cards).toHaveCount(2);
  expect(await categories.evaluate((group) => group.scrollWidth <= group.clientWidth)).toBe(true);
});

test('opens asset actions from the list and only removes unused assets', async ({ page }) => {
  const project = testProject();
  project.assets.push({ ...project.assets[0], id: 'unused', name: '未使用素材.mp4' });
  await page.addInitScript(
    (p) => localStorage.setItem('frameforge.project.v1', JSON.stringify(p)),
    project,
  );
  await page.goto('/');
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  const menu = page.getByRole('menu', { name: '素材操作' });
  const dialog = page.getByRole('dialog', { name: '删除素材' });
  const cards = page.locator('.asset-card');
  await cards.first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: '删除素材' }).click();
  await expect(dialog).toContainText('仍被节点、时间线、设定或制作镜头引用');
  await dialog.locator('.dialog-actions').getByRole('button', { name: '关闭' }).click();
  const unused = cards.filter({ hasText: '未使用素材.mp4' });
  await unused.press('Shift+F10');
  await menu.getByRole('menuitem', { name: '删除素材' }).click();
  await dialog.getByRole('button', { name: '删除素材' }).click();
  await expect(unused).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(unused).toBeVisible();
});

test('auditions audio in a compact row, seeks, and pauses when switching assets or views', async ({
  page,
}) => {
  const project = testProject();
  project.assets.push(
    ...['对白一', '对白二'].map((name, index) => ({
      id: `audio-preview-${index}`,
      name: `${name}.wav`,
      type: 'audio' as const,
      path: 'test-media/tone.wav',
      builtin: true,
      size: 0,
      durationMs: 20_000,
      width: 0,
      height: 0,
    })),
  );
  await page.addInitScript(
    (p) => localStorage.setItem('frameforge.project.v1', JSON.stringify(p)),
    project,
  );
  await page.goto('/');
  const category = page.getByRole('button', { name: '语音', exact: true });
  await category.click();
  const rain = page.locator('.asset-card').filter({ hasText: '对白一.wav' });
  const voice = page.locator('.asset-card').filter({ hasText: '对白二.wav' });
  await expect(page.locator('.asset-thumbnail')).toHaveCount(0);
  await expect(rain.locator('audio')).not.toHaveAttribute('src', /.+/);
  await rain.getByRole('button', { name: '试听 对白一.wav' }).press('Enter');
  await expect(rain.getByRole('button', { name: '暂停 对白一.wav' })).toBeVisible();
  const seek = rain.getByRole('slider', { name: '试听进度 对白一.wav' });
  await expect(seek).toBeEnabled();
  await seek.fill('5');
  await expect
    .poll(() => rain.locator('audio').evaluate((media: HTMLAudioElement) => media.currentTime))
    .toBeGreaterThanOrEqual(5);

  await voice.getByRole('button', { name: '试听 对白二.wav' }).click();
  await expect(rain.locator('audio')).toHaveJSProperty('paused', true);
  await expect(voice.locator('audio')).toHaveJSProperty('paused', false);
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  await expect(voice.getByRole('button', { name: '暂停 对白二.wav' })).toBeVisible();
  const playing = await voice.locator('audio').elementHandle();
  await page.getByRole('button', { name: '视频', exact: true }).click();
  await expect.poll(() => playing!.evaluate((media: HTMLAudioElement) => media.paused)).toBe(true);
  await expect(page.locator('.asset-thumbnail').first()).toBeVisible();
});
