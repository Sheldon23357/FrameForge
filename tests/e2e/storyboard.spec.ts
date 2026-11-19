import fs from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { createEditorTools } from '../../packages/agent/tools';
import { makeChoice, makeProject, makeScene } from '../../packages/domain/schema';
import { test, expect, type Page } from './fixtures';

test('Agent-created text pages can be edited in the inspector and timeline, then played and exported', async ({
  page,
  context,
}) => {
  const registry = createEditorTools();
  const toolContext = {
    project: makeProject(),
    selectedIds: [],
    activeChapterId: null,
    intents: [],
  };
  const create = (storyboardPages?: { text: string; durationMs: number }[]) =>
    registry.execute(
      'edit_scene',
      JSON.stringify({
        action: 'create',
        args: {
          kind: 'video',
          title: '故事板场景',
          notes: '主角听见异响，停下并看向门外。',
          storyboardPages,
        },
      }),
      toolContext,
    );
  expect(create().ok).toBe(false);
  const pages = [
    { text: '我推开门，听见屋里有脚步声。', durationMs: 2000 },
    { text: '一张折好的纸条躺在桌上。', durationMs: 1600 },
  ];
  const result = create(pages);
  expect(result.ok, result.summary).toBe(true);
  const { project } = toolContext;
  const [blank] = project.scenes;
  const scene = project.scenes[1];
  const ending = makeScene('ending', 2, blank.chapterId);
  ending.endingText = '我收好纸条。';
  scene.notes = '仅供作者查看的备注';
  scene.choices = [{ ...makeChoice(), label: '捡起纸条', targetId: ending.id }];
  project.scenes = [scene, ending];
  project.startNodeId = scene.id;
  project.chapters[0].startNodeId = scene.id;
  const read = registry.execute(
    'read_story',
    JSON.stringify({ action: 'read', args: { nodeId: scene.id, section: 'storyboard', limit: 1 } }),
    toolContext,
  );
  expect(read.data).toMatchObject({ pages: pages.slice(0, 1), total: 2, nextOffset: 1 });

  await page.addInitScript((p) => {
    localStorage.setItem('frameforge.project.v1', JSON.stringify(p));
  }, project);
  await page.goto('/');
  const storyboardHeader = page.getByText('剧情文字 · 分页播放', { exact: true });
  await expect(storyboardHeader).toHaveCSS('display', 'flex');
  await storyboardHeader.click();
  const editedPages = [
    { ...pages[0], text: '我推开门，走廊里传来一阵脚步声。' },
    { text: '桌上那张折好的纸条写着我的名字。', durationMs: 2400 },
  ];
  const inspectorText = page.getByRole('textbox', { name: '第 1 页正文', exact: true });
  await expect(page.locator('.inspector-storyboard').getByRole('spinbutton')).toHaveCount(0);
  await expect(inspectorText).toHaveValue(pages[0].text);
  await inspectorText.fill(editedPages[0].text);
  await inspectorText.press('Tab');
  await page.getByRole('button', { name: '编辑节点时间线', exact: true }).click();
  const timeline = page.getByRole('dialog', { name: /节点时间线/ });
  const firstClip = page.getByRole('button', { name: '剧情文字第 1 页', exact: true });
  const secondClip = page.getByRole('button', { name: '剧情文字第 2 页', exact: true });
  await expect(firstClip).toContainText(editedPages[0].text);
  await expect(firstClip.locator('.timeline-storyboard-excerpt')).toHaveCSS('font-size', '10px');
  await expect(secondClip).toContainText(pages[1].text);
  await secondClip.click();
  const timelinePreview = page.locator('.timeline-preview-stage .player-storyboard');
  await expect(timelinePreview).toContainText(pages[1].text);
  expect(
    await timelinePreview.locator('p').evaluate((p) => parseFloat(getComputedStyle(p).fontSize)),
  ).toBeGreaterThanOrEqual(18);
  const timelineText = timeline.getByRole('textbox', { name: '第 2 页正文', exact: true });
  await timelineText.fill(editedPages[1].text);
  await timelineText.press('Tab');
  const timelineTime = timeline.getByRole('spinbutton', {
    name: '第 2 页停留时长（秒）',
    exact: true,
  });
  await timeline.getByRole('button', { name: '缩小时间线' }).click();
  await timeline.getByRole('button', { name: '缩小时间线' }).click();
  const edge = (await secondClip.getByTitle('拖动调整剧情文字页时长').boundingBox())!;
  const clip = (await secondClip.boundingBox())!;
  const x = edge.x + edge.width / 2;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + clip.width / 2, y, { steps: 8 });
  await page.mouse.up();
  await expect(timelineTime).toHaveValue('2.4');
  await expect(secondClip).toContainText('2.40s');
  await timeline.getByRole('button', { name: '撤销剪辑' }).click();
  await expect(secondClip).toContainText('1.60s');
  await timeline.getByRole('button', { name: '重做剪辑' }).click();
  await expect(secondClip).toContainText('2.40s');
  await expect(timelinePreview).toContainText(editedPages[1].text);
  await page.getByRole('button', { name: '应用剪辑', exact: true }).click();

  const verifyPlayback = async (player: Page, fontSize: string) => {
    const board = player.locator('.player-storyboard');
    const copy = board.locator('.player-storyboard-copy');
    const choice = player.getByRole('button', { name: /捡起纸条/ });
    await expect(board).toContainText(editedPages[0].text);
    await expect(board).toContainText('1 / 2');
    await expect(copy.locator('p')).toHaveCSS('font-size', fontSize);
    await expect(copy).toHaveCSS('border-top-width', '0px');
    await expect(copy).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(choice).toBeHidden();
    const stage = player.getByRole('region', { name: '游戏画面', exact: true });
    await expect(stage).toBeFocused({ timeout: 750 });
    await player.keyboard.press('Space');
    await expect(board).toContainText(editedPages[1].text, { timeout: 1000 });
    await expect(board).toContainText('2 / 2');
    await expect(choice).toBeVisible();
    await expect(board).toContainText(editedPages[1].text);
    await choice.click();
    await expect(player.locator('.player-ending')).toContainText(ending.endingText);
  };

  await page.getByRole('button', { name: '导出作品', exact: true }).click();
  await page.getByLabel('导出格式').selectOption('web');
  const download = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: '导出作品', exact: true }).click();
  const files = unzipSync(new Uint8Array(await fs.readFile((await (await download).path())!)));
  const exported = JSON.parse(new TextDecoder().decode(files['game/project.json']));
  expect(exported.scenes[0]).toMatchObject({ notes: '', storyboardPages: editedPages });

  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
  await verifyPlayback(page, '34px');

  const game = await context.newPage();
  await game.setViewportSize({ width: 390, height: 780 });
  await game.route('http://storyboard.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname.slice(1) || 'index.html';
    const body = files[pathname];
    if (!body) return route.fulfill({ status: 404 });
    const contentType = pathname.endsWith('.js')
      ? 'text/javascript'
      : pathname.endsWith('.css')
        ? 'text/css'
        : pathname.endsWith('.json')
          ? 'application/json'
          : pathname.endsWith('.woff2')
            ? 'font/woff2'
            : 'text/html';
    await route.fulfill({ body: Buffer.from(body), contentType });
  });
  await game.goto('http://storyboard.test/');
  await game.getByRole('button', { name: '开始游戏', exact: true }).click();
  await verifyPlayback(game, '18px');
});

for (const type of ['image', 'video'] as const) {
  test(`keeps storyboard text over ${type} from the timeline through playback`, async ({
    page,
  }) => {
    const project = makeProject();
    const [node] = project.scenes;
    node.storyboardPages = [
      { text: '故事板开头', durationMs: 6000 },
      { text: '故事板片尾', durationMs: 6000 },
    ];
    const asset = {
      id: 'shot',
      name: '测试画面',
      type,
      path: type === 'image' ? 'test-media/primary.jpg' : 'test-media/primary.mp4',
      builtin: true,
      size: 1,
      durationMs: 6000,
      width: 960,
      height: 540,
    };
    project.assets = [asset];
    node.assetId = asset.id;
    node.durationMs = asset.durationMs;
    await page.addInitScript(
      (p) => localStorage.setItem('frameforge.project.v1', JSON.stringify(p)),
      project,
    );
    await page.goto('/');
    await page.getByRole('button', { name: '编辑节点时间线', exact: true }).click();
    const timeline = page.getByRole('dialog', { name: /节点时间线/ });
    const preview = timeline.locator('.timeline-preview-stage');
    const overlay = preview.locator('.player-storyboard-overlay');
    const toggle = timeline.getByRole('checkbox', { name: '在素材上显示剧情文字' });
    await expect(toggle).not.toBeChecked();
    await expect(overlay).toBeHidden();
    await toggle.check();
    await expect(overlay).toContainText('故事板开头');
    await expect(preview.locator(type === 'image' ? '.timeline-still' : 'video')).toBeVisible();
    await timeline.getByRole('button', { name: '剧情文字第 2 页' }).click();
    await expect(overlay).toContainText('故事板片尾');
    await expect(timeline.getByRole('textbox', { name: '第 2 页正文' })).toBeVisible();
    await toggle.uncheck();
    await expect(overlay).toBeHidden();
    await toggle.check();
    await timeline.getByRole('button', { name: '应用剪辑', exact: true }).click();
    await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
    const stage = page.getByRole('region', { name: '游戏画面' });
    await expect(stage.locator('.player-storyboard-overlay')).toContainText('故事板开头');
    await expect(stage.locator(type === 'image' ? '.timeline-still' : 'video')).toBeVisible();
  });
}

test('jumps to the last storyboard page and uses the destination chapter for fade timing', async ({
  page,
}) => {
  const project = makeProject();
  const [opening] = project.scenes;
  opening.storyboardPages = [
    { text: '起始页', durationMs: 30_000 },
    { text: '中间页', durationMs: 30_000 },
    { text: '最后一页', durationMs: 2000 },
  ];
  const next = makeScene('video', 2, opening.chapterId);
  next.storyboardPages = [{ text: '同章下一节点', durationMs: 1000 }];
  const ending = makeScene('ending', 3, 'chapter_two');
  ending.endingText = '跨章结局';
  opening.choices = [{ ...makeChoice('继续故事'), targetId: next.id }];
  next.nextId = ending.id;
  project.scenes.push(next, ending);
  project.chapters.push({ id: ending.chapterId, title: '第二章', startNodeId: ending.id });

  await page.addInitScript((p) => {
    localStorage.setItem('frameforge.project.v1', JSON.stringify(p));
  }, project);
  await page.clock.install({ time: new Date('2026-11-10T00:00:00Z') });
  await page.goto('/');
  await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
  await page.clock.pauseAt(new Date('2026-11-10T00:00:10Z'));

  const player = page.locator('.player-shell');
  const board = player.locator('.player-storyboard');
  const choice = player.getByRole('button', { name: /继续故事/ });
  await expect(board).toContainText('起始页');
  await page.keyboard.press('Control+Space');
  await expect(board).toContainText('最后一页');
  await expect(player).toHaveAttribute('data-position-ms', '60000');
  await page.keyboard.press('Space');
  await page.keyboard.press('Control+Space');
  await expect(player).toHaveAttribute('data-position-ms', '60000');
  await expect(choice).toBeHidden();

  const fadeOut = player.locator('.scene-transition.out');
  const fadeIn = player.locator('.scene-transition.in');
  await page.clock.runFor(2100);
  await choice.click();
  await expect(fadeOut).toHaveCSS('animation-duration', '0.15s');
  await expect(player).toHaveAttribute('data-node-id', opening.id);
  await page.clock.runFor(149);
  await expect(player).toHaveAttribute('data-node-id', opening.id);
  await page.clock.runFor(1);
  await expect(fadeIn).toHaveCSS('animation-duration', '0.15s');
  await expect(player).toHaveAttribute('data-node-id', next.id);
  await page.clock.runFor(150);
  await expect(fadeIn).toHaveCount(0);

  // The next node advances automatically. Step by frame to capture the start of its fade.
  for (let frame = 0; frame < 80 && !(await fadeOut.count()); frame++) {
    await page.clock.runFor(16);
  }
  await expect(fadeOut).toHaveCSS('animation-duration', '0.4s');
  await expect(player).toHaveAttribute('data-node-id', next.id);
  await page.clock.runFor(400);
  await expect(fadeIn).toHaveCSS('animation-duration', '0.4s');
  await expect(player).toHaveAttribute('data-node-id', ending.id);
  await page.clock.runFor(400);
  await expect(fadeIn).toHaveCount(0);
  await expect(player.locator('.player-ending')).toContainText(ending.endingText);
});

test('shows bound production frames in the blueprint and previews them from the node timeline', async ({
  page,
}) => {
  const project = makeProject();
  const [node] = project.scenes;
  node.storyboardPages = [{ text: '故事板正文', durationMs: 4000 }];
  project.assets = ['first', 'last'].map((id) => ({
    id,
    type: 'image',
    name: id,
    path: 'test-media/primary.jpg',
    builtin: true,
    size: 1,
    durationMs: 0,
    width: 960,
    height: 540,
  }));
  project.productionShots = [
    {
      id: 'shot',
      nodeId: node.id,
      label: 'S01',
      durationMs: 4000,
      firstFrameAssetId: 'first',
      lastFrameAssetId: 'last',
    },
    { id: 'tail', nodeId: node.id, label: 'S02', durationMs: 2000, lastFrameAssetId: 'last' },
    { id: 'empty', nodeId: node.id, label: 'S03', durationMs: 2000 },
  ];
  await page.addInitScript(
    (p) => localStorage.setItem('frameforge.project.v1', JSON.stringify(p)),
    project,
  );
  await page.goto('/');
  const poster = page.locator('.node-poster');
  await expect(poster.getByRole('img', { name: 'S02 · 尾帧' })).toBeVisible();
  await poster.getByRole('button', { name: '查看制作镜头帧' }).click();
  await expect(poster.getByRole('img', { name: 'S01 · 首帧' })).toBeVisible();
  await page.getByRole('button', { name: '编辑节点时间线', exact: true }).click();
  const timeline = page.getByRole('dialog', { name: /节点时间线/ });
  const cards = timeline.getByRole('group', { name: '分镜', exact: true });
  await expect(cards.getByRole('button')).toHaveCount(3);
  const firstCard = cards.getByRole('button', { name: 'S01', exact: true });
  const tailCard = cards.getByRole('button', { name: 'S02', exact: true });
  const emptyCard = cards.getByRole('button', { name: 'S03', exact: true });
  await expect(firstCard.locator('img')).toHaveCount(1);
  await expect(tailCard.locator('img')).toHaveCount(1);
  await expect(emptyCard).toContainText('暂无画面');
  await firstCard.focus();
  await page.keyboard.press('Space');
  await expect(firstCard).toHaveAttribute('aria-pressed', 'true');
  const details = timeline.getByRole('region', { name: '分镜详情' });
  await expect(details.getByRole('img', { name: '首帧', exact: true })).toBeVisible();
  await expect(details.getByRole('img', { name: '尾帧', exact: true })).toBeVisible();
  await details.getByRole('button', { name: '预览首帧' }).click();
  await expect(timeline.locator('.timeline-shot-preview')).toHaveJSProperty('complete', true);
  await expect
    .poll(() =>
      timeline
        .locator('.timeline-shot-preview')
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await timeline.getByRole('button', { name: '返回分镜详情' }).click();
  await expect(details).toBeVisible();
  await details.getByRole('button', { name: '预览首帧' }).click();
  await firstCard.click();
  await expect(firstCard).toHaveAttribute('aria-pressed', 'false');
  await expect(timeline.locator('.timeline-shot-preview')).toHaveCount(0);
  await expect(timeline.locator('.timeline-preview-stage')).toContainText('故事板正文');
  await tailCard.click();
  await expect(details.getByRole('img', { name: '尾帧', exact: true })).toBeVisible();
  await expect(details.getByRole('img', { name: '首帧', exact: true })).toHaveCount(0);
  await emptyCard.click();
  await expect(details.getByText('S03 · 2 秒')).toBeVisible();
  await emptyCard.click();
  await expect(emptyCard).toHaveAttribute('aria-pressed', 'false');
  await expect(details).toHaveCount(0);
  await expect(timeline.locator('.timeline-preview-stage')).toContainText('故事板正文');
  await firstCard.click();
  await details.getByRole('button', { name: '预览首帧' }).click();
  await timeline.getByRole('button', { name: '加入图片轨' }).click();
  await expect(timeline.getByRole('button', { name: '图片 1：first' })).toContainText('4.00s');
  await expect(timeline.getByRole('status').filter({ hasText: '剧情文字' })).toContainText(
    '有画面时隐藏',
  );
  await timeline.getByRole('button', { name: '编辑剧情文字' }).click();
  await expect(timeline.getByLabel('第 1 页正文')).toHaveValue('故事板正文');
  await timeline.getByRole('checkbox', { name: '在素材上显示剧情文字' }).check();
  await expect(timeline.locator('.timeline-preview-stage')).toContainText('故事板正文');
  await timeline.getByRole('button', { name: '图片 1：first' }).click();
  await timeline.getByRole('button', { name: '删除图片片段', exact: true }).click();
  await expect(timeline.getByRole('status').filter({ hasText: '剧情文字' })).toContainText(
    '分页播放',
  );
});

test('shows complete production directions on a narrow screen before any frames are generated', async ({
  page,
}) => {
  const project = makeProject();
  const [scene] = project.scenes;
  scene.storyboardPages = [{ text: '玩家看到的对白。', durationMs: 3000 }];
  project.worldSettings = [{ id: 'room', kind: 'location', name: '病房' }];
  project.productionShots = [
    {
      id: 'shot_01',
      nodeId: scene.id,
      label: 'S01',
      durationMs: 3500,
      source: '第一章场次 1-1',
      purpose: '交代角色刚刚苏醒',
      camera: '主观仰拍',
      startState: '先听见滴声',
      action: '慢慢睁眼',
      endState: '灯罩对上焦',
      audio: '监护仪三声滴响',
      firstFramePrompt: '冷白顶灯，一明一暗',
      lastFramePrompt: '清晰的灯罩边缘',
      videoPrompt: '先从黑场渐亮，再慢慢收实焦点',
      videoModel: '制作测试模型',
      settingIds: ['room'],
    },
    { id: 'shot_02', nodeId: scene.id, label: 'S02', durationMs: 2200, action: '视线下移' },
  ];
  await page.addInitScript(
    (p) => localStorage.setItem('frameforge.project.v1', JSON.stringify(p)),
    project,
  );
  await page.setViewportSize({ width: 700, height: 720 });
  await page.goto('/');
  await page.getByRole('button', { name: '编辑节点时间线', exact: true }).click();
  const timeline = page.getByRole('dialog', { name: /节点时间线/ });
  await timeline.getByRole('button', { name: 'S01', exact: true }).click();
  const details = timeline
    .locator('.timeline-preview-stage')
    .getByRole('region', { name: '分镜详情' });
  await expect(details.getByText('S01 · 3.5 秒')).toBeVisible();
  await expect(page.getByRole('dialog', { name: '分镜详情' })).toHaveCount(0);
  await expect(details.getByText('视频提示词', { exact: true })).toHaveCount(0);
  for (const value of [
    '第一章场次 1-1',
    '交代角色刚刚苏醒',
    '主观仰拍',
    '先听见滴声',
    '慢慢睁眼',
    '灯罩对上焦',
    '监护仪三声滴响',
    '病房',
  ]) {
    await expect(details.getByText(value, { exact: true })).toBeVisible();
  }
  for (const [label, prompt] of [
    ['画面提示词', '冷白顶灯，一明一暗'],
    ['尾帧提示词', '清晰的灯罩边缘'],
  ]) {
    await details.getByText(label, { exact: true }).click();
    await expect(details.getByText(prompt, { exact: true })).toBeVisible();
  }
  await timeline.getByRole('button', { name: 'S02', exact: true }).click();
  await expect(details.getByText('视线下移', { exact: true })).toBeVisible();
  await expect(details.getByText('主观仰拍', { exact: true })).toHaveCount(0);
  await timeline.getByRole('button', { name: '返回剪辑预览', exact: true }).click();
  await expect(timeline.locator('.timeline-preview-stage')).toContainText('玩家看到的对白。');
});
