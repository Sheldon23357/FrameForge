import { expect } from '@playwright/test';
import { seedBrowserProject, testWithWorkspace as test } from './workspace-fixture';
import { testProject } from '../fixtures/project';

test('saves project-level creative parameters with consistent typography and preserves older projects', async ({
  page,
}) => {
  const project = testProject();
  const legacy = {
    viewpoint: '跟随主角',
    hooks: ['时间循环'],
    characterTags: ['记者'],
    relationships: ['搭档'],
    chapterCount: 5,
  } satisfies NonNullable<typeof project.settings.creativeDefaults>;
  await seedBrowserProject(page, { ...project, settings: { ...project.settings, creativeDefaults: legacy } });
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: '主导航' });
  await navigation.getByRole('button', { name: '项目设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '创作默认值' })).toBeVisible();
  const defaults = page.locator('.settings-authoring');
  await expect(defaults.locator('.field-label')).toHaveText([
    '故事背景',
    '观感偏好',
    '受众偏好',
    '画面比例',
    '作品画风',
    '风格补充描述',
  ]);
  const fields = defaults.locator(
    '.field-label, input, select, textarea, select option, select optgroup',
  );
  expect(
    await fields.evaluateAll((elements) => [
      ...new Set(elements.map((element) => getComputedStyle(element).fontSize)),
    ]),
  ).toEqual(['13px']);
  const audience = page.getByRole('combobox', { name: '受众偏好', exact: true });
  await expect(audience).toHaveValue('');
  await expect(audience).toHaveCSS('border-top-width', '0px');
  await expect(audience).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await audience.click();
  await expect(page.locator('select:open')).toHaveCount(1);
  await expect
    .poll(() =>
      audience.evaluate((element) => getComputedStyle(element, '::picker(select)').backgroundColor),
    )
    .toBe('rgb(36, 36, 36)');
  await page.keyboard.press('Escape');
  await expect(page.locator('select:open')).toHaveCount(0);
  await expect(page.getByText(/随作品保存。创作 Agent/)).toHaveCount(0);
  await page.getByLabel('故事背景', { exact: true }).fill('都市悬疑');
  await audience.selectOption('泛人群');
  const artStyle = defaults.getByRole('combobox', { name: '作品画风', exact: true });
  const aspect = defaults.getByRole('combobox', { name: '画面比例', exact: true });
  await artStyle.selectOption('国产都市写实');
  await aspect.selectOption('9:16');
  await page.getByRole('button', { name: '保存创作默认值', exact: true }).click();
  await expect(page.getByText('已自动保存', { exact: true })).toBeVisible();
  await page.reload();
  await navigation.getByRole('button', { name: '项目设置', exact: true }).click();
  await expect(page.getByLabel('故事背景', { exact: true })).toHaveValue('都市悬疑');
  await expect(artStyle).toHaveValue('国产都市写实');
  await expect(aspect).toHaveValue('9:16');
  const saved = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('frameforge.project.v1') ?? '{}').settings.creativeDefaults,
  );
  expect(saved).toMatchObject({ ...legacy, genre: '都市悬疑', audience: '泛人群' });
});

test('the Agent composer sends messages without a skill button or overrides', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '剧本', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '创作 Agent 对话' });
  await expect(panel.getByRole('button', { name: '技能', exact: true })).toHaveCount(0);
  const composer = page.getByRole('textbox', { name: '向创作 Agent 发送消息' });
  await composer.fill('请按项目设置写一份大纲。');
  await page.evaluate(async () => {
    const modulePath = '/src/store/agent.ts';
    const { useAgent } = (await import(modulePath)) as typeof import('../../src/store/agent');
    useAgent.setState({
      send: async (user, _plan, input) => {
        sessionStorage.setItem('creative-input-test', JSON.stringify({ user, input }));
      },
    });
  });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(sessionStorage.getItem('creative-input-test') ?? '{}')),
    )
    .toEqual({ user: '请按项目设置写一份大纲。' });
  await expect(composer).toHaveValue('');
  await page.setViewportSize({ width: 760, height: 680 });
  await expect(panel.getByRole('combobox', { name: '对话模型服务商' })).toBeInViewport();
  await expect(panel.getByRole('button', { name: '发送消息' })).toBeInViewport();
});
