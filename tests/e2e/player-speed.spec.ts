import { test, expect } from './fixtures';
import { testProject } from '../fixtures/project';
import { prepareGameProject } from '../../packages/export/project';

test('holds Ctrl for 10× storyboard playback and stops at a choice', async ({ page }) => {
  const project = testProject();
  const opening = project.scenes[0];
  opening.assetId = undefined;
  opening.storyboardPages = [
    { text: '先听见树叶响。', durationMs: 3000 },
    { text: '树后有一条路。', durationMs: 10000 },
  ];
  opening.choicesAtMs = 9000;

  await page.clock.install();
  await page.addInitScript(
    (value) => localStorage.setItem('frameforge.project.v1', JSON.stringify(value)),
    project,
  );
  await page.goto('/');
  await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
  const player = page.locator('.player-shell');
  const position = async () => Number(await player.getAttribute('data-position-ms'));
  const before = await position();

  await page.keyboard.down('Control');
  await page.clock.runFor(500);
  await expect(page.locator('.player-storyboard-copy p')).toHaveText('树后有一条路。');
  const fast = await position();
  expect(fast - before).toBeGreaterThan(4300);
  expect(fast - before).toBeLessThan(6500);

  await page.keyboard.up('Control');
  const released = await position();
  await page.clock.runFor(500);
  expect((await position()) - released).toBeLessThan(850);

  await page.keyboard.down('Control');
  await page.clock.runFor(1800);
  await expect(page.locator('.player-choice')).toHaveCount(2);
  await expect(player).toHaveAttribute('data-position-ms', '9000');
  await page.clock.runFor(500);
  await expect(player).toHaveAttribute('data-position-ms', '9000');
  await page.keyboard.up('Control');
});

for (const timeline of [false, true]) {
  test(`switches ${timeline ? 'timeline' : 'single'} video playback rate and resets on blur`, async ({
    page,
  }) => {
    const project = testProject();
    const opening = project.scenes[0];
    opening.choicesAtMs = null;
    if (timeline) {
      opening.timeline = {
        videoClips: [
          {
            id: 'opening',
            assetId: opening.assetId!,
            trimStartMs: 0,
            trimEndMs: 9000,
            volume: 1,
          },
        ],
        audioClips: [],
      };
    }
    await page.addInitScript(
      (value) => localStorage.setItem('frameforge.project.v1', JSON.stringify(value)),
      project,
    );
    await page.goto('/');
    await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
    const video = page.locator('.player-stage video:visible');
    await expect(video).toHaveJSProperty('paused', false);
    await page.keyboard.down('Control');
    await expect(video).toHaveJSProperty('playbackRate', 10);
    await page.keyboard.up('Control');
    await expect(video).toHaveJSProperty('playbackRate', 1);
    await page.keyboard.down('Control');
    await expect(video).toHaveJSProperty('playbackRate', 10);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(video).toHaveJSProperty('playbackRate', 1);
    await page.keyboard.up('Control');
  });
}

test('web game plays stills and timeline audio at the same rate', async ({ page }) => {
  const project = testProject();
  const opening = project.scenes[0];
  const image = project.assets.find(({ id }) => id === opening.assetId)!;
  image.type = 'image';
  image.path = 'test-media/primary.jpg';
  image.durationMs = 0;
  const ambient = 'test-media/tone.wav';
  project.assets.push({
    id: 'ambient',
    name: '测试音频',
    type: 'audio',
    path: ambient,
    durationMs: 6000,
    width: 0,
    height: 0,
    size: 0,
    builtin: true,
  });
  opening.timeline = {
    stillClips: [{ id: 'opening-image', assetId: image.id, durationMs: 12000 }],
    videoClips: [],
    audioClips: [
      {
        id: 'opening-ambient',
        assetId: 'ambient',
        startMs: 0,
        trimStartMs: 0,
        trimEndMs: 6000,
        durationMs: 12000,
        volume: 1,
        loop: true,
      },
    ],
  };
  opening.choicesAtMs = null;
  await page.route('**/web-player/game/project.json', (route) =>
    route.fulfill({ json: prepareGameProject(project) }),
  );
  await page.route('**/web-player/game/files/**', async (route) => {
    const asset = new URL(route.request().url()).pathname.split('/game/files/')[1];
    await route.fulfill({ response: await route.fetch({ url: `/${asset}` }) });
  });
  await page.goto('/web-player/index.html');
  await page.getByRole('button', { name: '开始游戏', exact: true }).click();
  await expect(page.locator('.timeline-still')).toBeVisible();
  const audio = page.locator('.player-stage audio');
  await expect(audio).toHaveJSProperty('paused', false);
  await page.keyboard.down('Control');
  await expect(audio).toHaveJSProperty('playbackRate', 10);
  await page.keyboard.up('Control');
  await expect(audio).toHaveJSProperty('playbackRate', 1);
});
