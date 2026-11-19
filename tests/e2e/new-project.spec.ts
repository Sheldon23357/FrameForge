import { expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testWithWorkspace as test } from './workspace-fixture';

test('opens an empty project and loads bundled skills in a portable release', async ({
  testWorkspace,
}) => {
  const packaged = process.env.FRAMEFORGE_TEST_EXECUTABLE;
  test.skip(!packaged, 'Requires a packaged Windows editor.');
  const portable = path.join(testWorkspace, 'portable');
  await fs.cp(path.dirname(packaged!), portable, { recursive: true });
  const env = { ...process.env, FRAMEFORGE_TEST: '1' };
  for (const name of ['FRAMEFORGE_USER_DATA', 'ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL']) {
    delete (env as NodeJS.ProcessEnv)[name];
  }
  const app = await electron.launch({
    executablePath: path.join(portable, path.basename(packaged!)),
    env,
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '未命名作品', exact: true })).toBeVisible();
    await expect(page.locator('.asset-card')).toHaveCount(0);
    const catalog = await page.evaluate(() => window.frameforge!.agentSkills.refresh());
    expect(catalog.issues).toEqual([]);
    expect(catalog.skills).toHaveLength(11);
    expect(catalog.skills.map((skill) => skill.name)).toContain('frameforge-project-setup');
  } finally {
    await app.close();
  }
});

test('creates the desktop project in the selected empty folder and keeps existing work on cancel', async ({
  testWorkspace,
}) => {
  const profile = path.join(testWorkspace, 'profile');
  const occupied = path.join(testWorkspace, 'existing');
  const destination = path.join(testWorkspace, '新作品');
  await Promise.all([profile, occupied, destination].map((folder) => fs.mkdir(folder)));
  const existing = path.join(occupied, 'project.frameforge');
  await fs.writeFile(existing, '已有工程');
  const env = { ...process.env, FRAMEFORGE_TEST: '1', FRAMEFORGE_USER_DATA: profile };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    const before = await page.evaluate(
      async () => (await window.frameforge!.bootstrap()).project.id,
    );
    const mockFolder = (folder: string | null) =>
      app.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({
          canceled: !selected,
          filePaths: selected ? [selected] : [],
        });
      }, folder);
    await page.locator('.project-menu').click();
    await page.getByRole('menuitem', { name: '新建作品', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建作品', exact: true });
    await dialog.getByLabel('作品名称').fill('新作品');
    const defaultDirectory = path.join(await fs.realpath(profile), 'productions', '新作品');
    const directory = dialog.getByLabel('作品保存目录');
    const customize = dialog.getByRole('button', { name: '自定义' });
    const create = dialog.getByRole('button', { name: '创建工程' });
    await expect(directory).toHaveValue(defaultDirectory);
    const pathBox = (await directory.boundingBox())!;
    const customizeBox = (await customize.boundingBox())!;
    expect(customizeBox.x).toBeGreaterThan(pathBox.x + pathBox.width);
    expect(customizeBox.y).toBe(pathBox.y);
    await expect(fs.stat(defaultDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    await mockFolder(null);
    await customize.click();
    await expect(directory).toHaveValue(defaultDirectory);
    await expect(customize).toBeEnabled();
    expect(await page.evaluate(async () => (await window.frameforge!.bootstrap()).project.id)).toBe(
      before,
    );
    await mockFolder(occupied);
    await customize.click();
    await expect(directory).toHaveValue(await fs.realpath(occupied));
    await create.click();
    await expect(dialog.getByRole('alert')).toContainText('请选择空文件夹');
    expect(await fs.readFile(existing, 'utf8')).toBe('已有工程');
    await mockFolder(destination);
    await customize.click();
    await expect(directory).toHaveValue(await fs.realpath(destination));
    await create.click();
    await expect(dialog).toBeHidden();
    const file = path.join(destination, 'project.frameforge');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(saved).toMatchObject({ title: '新作品', assets: [], scenes: [expect.any(Object)] });
    expect(saved.id).not.toBe(before);
    const boot = await page.evaluate(() => window.frameforge!.bootstrap());
    expect(boot.filePath).toBe(await fs.realpath(file));
    expect(boot.project.id).toBe(saved.id);
    expect(
      JSON.parse(await fs.readFile(path.join(destination, 'autosave.frameforge'), 'utf8')).id,
    ).toBe(saved.id);
    await page.locator('.project-menu').click();
    await page.getByRole('menuitem', { name: '新建作品', exact: true }).click();
    await expect(directory).toHaveValue(defaultDirectory);
    await create.click();
    await expect(dialog).toBeHidden();
    const automatic = path.join(defaultDirectory, 'project.frameforge');
    expect(JSON.parse(await fs.readFile(automatic, 'utf8')).title).toBe('新作品');
    expect((await page.evaluate(() => window.frameforge!.bootstrap())).filePath).toBe(
      await fs.realpath(automatic),
    );
  } finally {
    await app.close();
  }
});
