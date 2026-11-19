import { launchEditor } from './launch-editor';
import { clickPlayerAction, handlePlayerNotices, resumePlayer } from './player-helpers';
import { test, expect, _electron as electron } from './fixtures';
import path from 'node:path';
import fs from 'node:fs/promises';
import { makeProject } from '../../packages/domain/schema';
test.use({ actionTimeout: 15000 });

test('serves a small cached image on the blueprint and the original for playback', async ({
  testWorkspace: root,
}) => {
  const profile = path.join(root, 'profile');
  const project = makeProject();
  const bytes = await fs.readFile('public/app-icon.png');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const asset = {
    id: 'blueprint-poster',
    name: 'Poster',
    path: 'poster.png',
    type: 'image' as const,
    size: bytes.length,
    width,
    height,
    durationMs: 0,
    builtin: false,
  };
  project.assets.push(asset);
  project.scenes[0].assetId = asset.id;
  await fs.writeFile(path.join(root, 'poster.png'), bytes);
  await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'recovery.json'), JSON.stringify({ project, root }));
  const app = await launchEditor({
    args: ['.'],
    env: { ...process.env, FRAMEFORGE_TEST: '1', FRAMEFORGE_USER_DATA: profile },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    const poster = page.locator('.node-poster img').first();
    await expect
      .poll(() => poster.evaluate((image: HTMLImageElement) => image.naturalHeight))
      .toBe(180);
    await expect
      .poll(() => poster.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(Math.round((width / height) * 180));
    const fullSize = await page.evaluate(async (id) => {
      const image = new Image();
      image.src = window.frameforge!.assetUrl(id);
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }, asset.id);
    expect(fullSize).toEqual([width, height]);
    expect(await fs.readdir(path.join(profile, 'Cache', 'frameforge-thumbnails-v1'))).toHaveLength(
      1,
    );
  } finally {
    await app.close();
  }
});

test('reopens the newer production revision even after autosaving an older open project', async ({
  testWorkspace: root,
}) => {
  const file = path.join(root, 'project.frameforge');
  const original = { ...makeProject(), title: 'Revision one', revision: 1 };
  await fs.writeFile(file, JSON.stringify(original));
  const app = await launchEditor({
    args: ['.'],
    env: { ...process.env, FRAMEFORGE_TEST: '1', FRAMEFORGE_USER_DATA: path.join(root, 'profile') },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow, dialog }, selected) => {
      BrowserWindow.getAllWindows()[0].show();
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, file);
    const open = async () => {
      await page.locator('.project-menu').click();
      await page.getByRole('menuitem', { name: /打开工程/ }).click();
    };
    await open();
    await expect(page.getByRole('button', { name: original.title, exact: true })).toBeVisible();
    const production = { ...original, title: 'Revision two', revision: 2 };
    await fs.writeFile(file, JSON.stringify(production));
    const autosaveFile = path.join(root, 'autosave.frameforge');
    await fs.writeFile(autosaveFile, JSON.stringify(original));
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(autosaveFile, later, later);
    await open();
    await expect(page.getByRole('button', { name: production.title, exact: true })).toBeVisible();
    expect(JSON.parse(await fs.readFile(autosaveFile, 'utf8')).revision).toBe(2);
  } finally {
    await app.close();
  }
});

test('persists undo as a newer revision when reopening an autosaved desktop project', async ({
  testWorkspace: root,
}) => {
  const file = path.join(root, 'project.frameforge');
  const autosave = path.join(root, 'autosave.frameforge');
  const profile = path.join(root, 'profile');
  const original = makeProject();
  await fs.writeFile(file, JSON.stringify(original));
  const launch = () =>
    launchEditor({
      args: ['.'],
      env: { ...process.env, FRAMEFORGE_TEST: '1', FRAMEFORGE_USER_DATA: profile },
    });
  let app = await launch();
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow, dialog }, selected) => {
      BrowserWindow.getAllWindows()[0].show();
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, file);
    await page.locator('.project-menu').click();
    await page.getByRole('menuitem', { name: /打开工程/ }).click();
    await expect(page.getByRole('button', { name: original.title, exact: true })).toBeVisible();
    const readAutosave = async () => JSON.parse(await fs.readFile(autosave, 'utf8'));
    await page.getByRole('button', { name: '编辑节点名称', exact: true }).click();
    await page.getByLabel('节点名称', { exact: true }).fill('自动保存后再撤销');
    await page.getByLabel('节点名称', { exact: true }).blur();
    await expect.poll(async () => (await readAutosave()).scenes[0].title).toBe('自动保存后再撤销');
    const edited = await readAutosave();
    await page.getByRole('button', { name: '撤销（Ctrl Z）', exact: true }).click();
    await expect
      .poll(async () => (await readAutosave()).scenes[0].title)
      .toBe(original.scenes[0].title);
    expect((await readAutosave()).revision).toBeGreaterThan(edited.revision);

    await app.close();
    app = await launch();
    const restarted = await app.firstWindow();
    const boot = await restarted.evaluate(() => window.frameforge!.bootstrap());
    expect(boot.project.scenes[0].title).toBe(original.scenes[0].title);
    expect(boot.project.revision).toBeGreaterThan(edited.revision);
  } finally {
    await app.close();
  }
});

test('opens the project picker in the library or the current external project directory', async ({
  testWorkspace: root,
}) => {
  const userData = path.join(root, 'profile');
  const library = path.join(userData, 'productions');
  const inside = path.join(library, '内部作品', 'project.frameforge');
  const outside = path.join(root, '外部作品', 'project.frameforge');
  for (const [file, title] of [
    [inside, '内部作品'],
    [outside, '外部作品'],
  ]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ ...makeProject(), title }));
  }
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined),
    ),
    FRAMEFORGE_TEST: '1',
    FRAMEFORGE_USER_DATA: userData,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchEditor({ args: ['.'], env });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    const open = async (file?: string) => {
      await app.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async (
          ownerOrOptions: Electron.BaseWindow | Electron.OpenDialogOptions,
          options?: Electron.OpenDialogOptions,
        ) => {
          (globalThis as typeof globalThis & { pickerPath?: string }).pickerPath = (
            options ?? (ownerOrOptions as Electron.OpenDialogOptions)
          ).defaultPath;
          return selected
            ? { canceled: false, filePaths: [selected] }
            : { canceled: true, filePaths: [] };
        };
      }, file);
      await page.locator('.project-menu').click();
      await page.getByRole('menuitem', { name: /打开工程/ }).click();
    };
    const pickerPath = () =>
      app.evaluate(() => (globalThis as typeof globalThis & { pickerPath?: string }).pickerPath);
    await open(inside);
    await expect(page.getByRole('button', { name: '内部作品', exact: true })).toBeVisible();
    expect(await pickerPath()).toBe(await fs.realpath(library));
    await open(outside);
    await expect(page.getByRole('button', { name: '外部作品', exact: true })).toBeVisible();
    expect(await pickerPath()).toBe(await fs.realpath(library));
    await open();
    await expect.poll(pickerPath).toBe(await fs.realpath(path.dirname(outside)));
  } finally {
    await app.close();
  }
});
test('desktop imports, saves relocatable assets, exports and launches the independent player', async ({
  testWorkspace: root,
}) => {
  test.setTimeout(180000);
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.FRAMEFORGE_TEST = '1';
  env.FRAMEFORGE_USER_DATA = path.join(root, 'user-data');
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.FRAMEFORGE_TEST_EXECUTABLE;
  const app = await launchEditor({ args: executablePath ? [] : ['.'], executablePath, env });
  try {
    const page = await app.firstWindow();
    // Hidden native windows can throttle animation frames and stall actionability
    // checks. Geometry and player interaction tests need a presented window.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await handlePlayerNotices(page);
    await expect(page.getByRole('heading', { name: '创作资源' })).toBeVisible();
    await expect(page.locator('.asset-thumbnail img').first()).toHaveJSProperty(
      'naturalWidth',
      640,
    );
    const inputFile = path.resolve('public/test-media/primary.mp4');
    await app.evaluate(({ dialog }, inputFile) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [inputFile] });
    }, inputFile);
    await page.getByRole('button', { name: '导入视频 / 图片' }).click();
    await expect(page.locator('.asset-card')).toHaveCount(4, { timeout: 25000 });
    await app.evaluate(({ shell }) => {
      shell.showItemInFolder = (file) => {
        (globalThis as typeof globalThis & { revealedAsset?: string }).revealedAsset = file;
      };
    });
    await page.locator('.asset-card').last().click({ button: 'right' });
    await page.getByRole('menuitem', { name: '在文件夹中查看' }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as typeof globalThis & { revealedAsset?: string }).revealedAsset,
        ),
      )
      .toMatch(/[\\/]assets[\\/]video[\\/].+\.mp4$/);
    await page.getByRole('button', { name: '故事大纲', exact: true }).click();
    await page.getByRole('button', { name: '新建章节', exact: true }).click();
    await page.getByLabel('章节名称', { exact: true }).fill('第二章 · 相遇');
    await page.getByRole('button', { name: '创建章节', exact: true }).click();
    await page.getByLabel('当前章节').selectOption('');
    await page
      .locator('.chapter-nodes')
      .getByRole('button', { name: /奖励节点/ })
      .click();
    await page.getByLabel('所属章节').selectOption({ label: '第二章 · 相遇' });
    await expect(page.getByRole('button', { name: '工程检查通过', exact: true })).toBeVisible();
    const saveFile = path.join(root, 'project', 'project.frameforge');
    await fs.mkdir(path.dirname(saveFile), { recursive: true });
    await app.evaluate(({ dialog }, saveFile) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveFile });
    }, saveFile);
    await page.getByRole('button', { name: '保存工程（Ctrl S）' }).click();
    await expect(page.getByRole('status')).toContainText('工程和素材已保存');
    const saved = JSON.parse(await fs.readFile(saveFile, 'utf8'));
    expect(saved.assets).toHaveLength(4);
    expect(saved.chapters).toHaveLength(2);
    expect(saved.chapters[1].startNodeId).toBe('scene_reward');
    expect(saved.scenes.find((s: { id: string }) => s.id === 'scene_reward').chapterId).toBe(
      saved.chapters[1].id,
    );
    expect(
      await fs.stat(path.join(root, 'project', saved.assets[3].path)).then((s) => s.size),
    ).toBeGreaterThan(1000);
    await page.reload();
    await page.getByLabel('当前章节').selectOption({ label: '第二章 · 相遇' });
    await expect(page.locator('.story-node h3')).toHaveText('奖励节点');
    await page.getByRole('button', { name: '故事大纲', exact: true }).click();
    await page.getByLabel('当前章节').selectOption('');
    await page.getByRole('button', { name: '试玩 F5' }).click();
    await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
    await expect(page.locator('.player-stage video')).toHaveJSProperty('readyState', 4);
    await resumePlayer(page);
    await expect(page.getByRole('button', { name: /进入路线 A/ })).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('button', { name: '退出试玩' }).click();
    const exportRoot = path.join(root, 'exports');
    await fs.mkdir(exportRoot, { recursive: true });
    await app.evaluate(({ dialog }, exportRoot) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [exportRoot] });
    }, exportRoot);
    await page.getByRole('button', { name: '导出作品', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '导出作品', exact: true }).click();
    await expect(page.getByRole('heading', { name: '导出完成' })).toBeVisible({
      timeout: 90000,
    });
    const folders = await fs.readdir(exportRoot);
    expect(folders).toHaveLength(1);
    const exported = path.join(exportRoot, folders[0]);
    const player = await electron.launch({
      executablePath: path.join(exported, '测试工程.exe'),
      args: [],
      env: { ...env, FRAMEFORGE_USER_DATA: path.join(root, 'player-data') },
    });
    try {
      const window = await player.firstWindow();
      await player.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
      await handlePlayerNotices(window);
      await expect(window.locator('.player-shell.standalone')).toBeVisible();
      await expect(window.locator('.player-header')).toHaveCount(0);
      await expect(window.locator('.player-stage video')).toHaveJSProperty('readyState', 4);
      const dimensions = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(Math.abs(dimensions.width / dimensions.height - 16 / 9)).toBeLessThan(0.005);
      await expect(window.locator('#player-menu')).toBeHidden();
      await expect(window.locator('.player-stage')).toHaveCSS('border-top-width', '0px');
      await expect(window.locator('.player-stage video')).toHaveCSS('object-fit', 'cover');
      const stage = await window.locator('.player-stage').boundingBox();
      expect(stage).toEqual({ x: 0, y: 0, ...dimensions });
      await window.locator('.player-stage').click({ position: { x: 8, y: 200 } });
      await expect(window.locator('.player-topbar .player-scene-title h2')).toHaveText(
        '测试开场',
      );
      await clickPlayerAction(window, '全屏画面');
      await expect.poll(() => window.evaluate(() => !!document.fullscreenElement)).toBe(true);
      await clickPlayerAction(window, '存读档');
      await window.getByRole('tab', { name: '存档', exact: true }).click();
      await expect(window.getByRole('dialog', { name: '存读档', exact: true })).toBeVisible();
      await window.getByRole('button', { name: /01 空存档/ }).click();
      await clickPlayerAction(window, '存读档');
      await window.getByRole('tab', { name: '读档', exact: true }).click();
      await window.getByRole('button', { name: /01 测试开场/ }).click();
      await clickPlayerAction(window, '退出全屏');
      await expect.poll(() => window.evaluate(() => !!document.fullscreenElement)).toBe(false);
      await expect
        .poll(() => window.evaluate(() => innerWidth / innerHeight))
        .toBeCloseTo(16 / 9, 2);
      await window.locator('.player-stage').click({ position: { x: 8, y: 200 } });
      await expect(window.getByRole('region', { name: '游戏画面', exact: true })).toBeFocused();
      await expect(window.getByRole('button', { name: /进入路线 A/ })).toBeVisible({
        timeout: 15000,
      });
      await window.getByRole('button', { name: /进入路线 A/ }).click();
      await expect(window.locator('.player-scene-title h2')).toHaveText('奖励节点');
      await expect(window.locator('.scene-transition')).toHaveCount(0);
      await window.getByRole('button', { name: '菜单', exact: true }).click();
      await window
        .getByRole('dialog', { name: '游戏菜单', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click();
      await window.keyboard.press('Escape');
      await expect(window.locator('#player-menu')).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(window.locator('#player-menu')).toBeHidden();
    } finally {
      await player.close();
    }
    const gameFile = path.join(exported, 'resources/app/game/project.json');
    const original = await fs.readFile(gameFile, 'utf8');
    expect(JSON.parse(original).chapters).toEqual(saved.chapters);
    try {
      for (const [width, height] of [
        [1080, 1920],
        [1440, 1080],
        [1080, 1080],
      ]) {
        const game = JSON.parse(original);
        game.settings.width = width;
        game.settings.height = height;
        await fs.writeFile(gameFile, JSON.stringify(game));
        const variant = await electron.launch({
          executablePath: path.join(exported, '测试工程.exe'),
          args: [],
          env: { ...env, FRAMEFORGE_USER_DATA: path.join(root, `player-${width}-${height}`) },
        });
        try {
          const window = await variant.firstWindow();
          await variant.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
          await handlePlayerNotices(window);
          await expect(window.locator('.player-shell.standalone')).toBeVisible();
          await expect
            .poll(() => window.evaluate(() => innerWidth / innerHeight))
            .toBeCloseTo(width / height, 2);
          for (const edge of ['right', 'bottom', 'top-left']) {
            await variant.evaluate(({ BrowserWindow }, edge) => {
              const win = BrowserWindow.getAllWindows()[0];
              const bounds = win.getBounds();
              win.emit(
                'will-resize',
                { preventDefault() {} },
                {
                  ...bounds,
                  width: bounds.width - 80,
                  height: bounds.height - 60,
                },
                { edge },
              );
            }, edge);
            await expect
              .poll(() => window.evaluate(() => innerWidth / innerHeight))
              .toBeCloseTo(width / height, 2);
          }
          await window.locator('.player-stage').click({ position: { x: 8, y: 200 } });
          const portraitUI = await window.evaluate(
            () => matchMedia('(orientation: portrait)').matches,
          );
          const top = window.getByRole('region', { name: '游戏顶部菜单', exact: true });
          await expect(top.getByRole('button', { name: /^(暂停|播放)$/ })).toBeInViewport();
          for (const label of ['跳至交互', '存读档', '重新开始'])
            await expect(top.getByRole('button', { name: label, exact: true })).toHaveCount(0);
          if (portraitUI) {
            await expect(top.getByRole('button')).toHaveCount(1);
            await expect(window.getByRole('button', { name: '查看属性', exact: true })).toHaveCount(
              0,
            );
          }
          await window.getByRole('button', { name: '菜单', exact: true }).click();
          const menu = window.getByRole('dialog', { name: '游戏菜单', exact: true });
          const fullscreen = menu.getByRole('button', { name: '全屏画面', exact: true });
          if (portraitUI) await fullscreen.scrollIntoViewIfNeeded();
          await expect(fullscreen).toBeInViewport();
          await expect(menu.getByRole('button', { name: '跳至交互', exact: true })).toHaveCount(0);
          for (const label of ['存读档', '重新开始'])
            await expect(menu.getByRole('button', { name: label, exact: true })).toBeVisible();
          if (portraitUI) {
            for (const label of ['存读档', '查看属性', '查看道具']) {
              await expect(menu.getByRole('button', { name: label, exact: true })).toBeVisible();
            }
            await menu.getByRole('button', { name: '存读档', exact: true }).click();
            await expect(
              window.getByRole('dialog', { name: '存读档', exact: true }).getByRole('tab'),
            ).toHaveCount(2);
          }
        } finally {
          await variant.close();
        }
      }
    } finally {
      await fs.writeFile(gameFile, original);
    }
    await fs.writeFile('.local/last-export-path.txt', exported);
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page
      .locator('.chapter-nodes')
      .getByRole('button', { name: /测试开场/ })
      .click();
    await page.getByRole('button', { name: '编辑节点名称', exact: true }).click();
    await page.getByLabel('节点名称', { exact: true }).fill('关闭瞬间也要保存');
  } finally {
    await app.close();
  }
  const recovered = JSON.parse(
    await fs.readFile(path.join(root, 'user-data', 'recovery.json'), 'utf8'),
  );
  expect(recovered.project.scenes[0].title).toBe('关闭瞬间也要保存');
});
