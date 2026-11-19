import { launchEditor } from './launch-editor';
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testWithWorkspace as test } from './workspace-fixture';

test('desktop settings automatically discover skills from disk and report refresh results', async ({
  testWorkspace: root,
}, testInfo) => {
  const skillName = 'frameforge-chapter-blueprint';
  const skill = path.join(root, 'skills', skillName);
  await fs.cp(path.resolve('skills', skillName), skill, { recursive: true });
  const env = Object.fromEntries(
    Object.entries({ ...process.env, FRAMEFORGE_TEST: '1', FRAMEFORGE_USER_DATA: root }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchEditor({ args: ['.'], env });
  try {
    await app.evaluate(({ shell }) => {
      shell.openPath = async (folder) => {
        if (folder !== process.env.FRAMEFORGE_USER_DATA + '\\skills') return 'unexpected folder';
        process.emitWarning('Verified local skill folder');
        return '';
      };
    });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设置', exact: true });
    await dialog.getByRole('button', { name: '本地技能', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('已识别 1 个技能');
    await expect(dialog.getByText(skillName, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await dialog.getByRole('button', { name: '打开文件夹' }).click();
    await expect(dialog.getByRole('button', { name: '打开文件夹' })).toBeEnabled();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.screenshot({ path: testInfo.outputPath('skills-populated.png') });
    await fs.writeFile(path.join(skill, 'SKILL.md'), 'invalid skill');
    await dialog.getByRole('button', { name: '刷新技能' }).click();
    await expect(dialog.getByRole('status')).toHaveText('已识别 0 个技能');
    await expect(dialog.getByText(/缺少有效的 YAML 元数据/)).toBeVisible();
    await fs.unlink(path.join(skill, 'SKILL.md'));
    await dialog.getByRole('button', { name: '刷新技能' }).click();
    await expect(dialog.getByText('还没有可用技能')).toBeVisible();
    await expect(dialog.getByText(/扫描提示/)).toHaveCount(0);
    await dialog.screenshot({ path: testInfo.outputPath('skills-empty.png') });
    await page.setViewportSize({ width: 620, height: 600 });
    await expect(dialog.getByRole('button', { name: '打开文件夹' })).toBeInViewport();
    await expect(dialog.getByText('还没有可用技能')).toBeInViewport();
    await dialog.screenshot({ path: testInfo.outputPath('skills-narrow.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('.story-node').first()).toBeVisible();
    await expect(page.locator('.inspector')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('keeps installed skills in settings without a skill button in the desktop composer', async ({
  testWorkspace: root,
}) => {
  const name = 'frameforge-script-review';
  await fs.cp(path.resolve('skills', name), path.join(root, 'skills', name), { recursive: true });
  const env = { ...process.env, FRAMEFORGE_TEST: '1', FRAMEFORGE_USER_DATA: root };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const app = await launchEditor({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    const composer = page.getByRole('complementary', { name: '创作 Agent 对话' });
    await expect(composer.getByRole('textbox', { name: '向创作 Agent 发送消息' })).toBeVisible();
    await expect(composer.getByRole('button', { name: '技能', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.getByRole('button', { name: '本地技能', exact: true }).click();
    await expect(settings.getByText(name, { exact: true })).toBeVisible();
  } finally {
    await app.close();
  }
});
