import { test, expect } from './fixtures';
import { makeChoice } from '../../packages/domain/schema';
import { testProject } from '../fixtures/project';

test('hides a locked choice and keeps the remaining choices fully readable at both viewport sizes', async ({
  page,
}) => {
  const p = testProject();
  const opening = p.scenes[0];
  opening.choicesAtMs = 0;
  opening.choices.push(
    { ...makeChoice('路线 C'), targetId: 'scene_alternate' },
    {
      ...makeChoice('锁定路线'),
      targetId: 'scene_alternate',
      hiddenWhenLocked: true,
      condition: { kind: 'item', itemId: 'leaf', op: 'gte', count: 1 },
    },
  );
  await page.goto('/');
  await page.getByRole('heading', { name: '创作资源', exact: true }).waitFor();
  await page.evaluate(
    (project) => localStorage.setItem('frameforge.project.v1', JSON.stringify(project)),
    p,
  );
  await page.reload();
  await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
  await page.locator('.player-stage').click({ position: { x: 8, y: 200 } });
  await expect(page.getByRole('button', { name: '锁定路线' })).toHaveCount(0);
  await expect(page.locator('.player-choice')).toHaveCount(3);
  await expect(page.locator('.player-choice strong').first()).toHaveCSS('font-size', '18px');
  await expect(page.locator('.player-choice strong').first()).toHaveCSS('font-weight', '650');
  for (const [width, height] of [
    [1600, 1000],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const option of await page.locator('.player-choice').all())
      await expect(option).toBeInViewport({ ratio: 1 });
    if (width === 390)
      await expect(page.locator('.player-choice strong').first()).toHaveCSS('font-size', '16px');
  }
  await page.screenshot({ path: '.local/previews/player-choices-bold-mobile.png' });
});

test('edits an optional question and shows it above the choices only during interaction', async ({
  page,
}) => {
  const project = testProject();
  const opening = project.scenes[0];
  opening.assetId = undefined;
  opening.storyboardPages = [{ text: '林中亮起一盏灯。', durationMs: 3000 }];
  opening.choicesAtMs = null;
  await page.goto('/');
  await page.getByRole('heading', { name: '创作资源', exact: true }).waitFor();
  await page.evaluate(
    (value) => localStorage.setItem('frameforge.project.v1', JSON.stringify(value)),
    project,
  );
  await page.reload();
  await page.locator('.inspector-tabs').getByRole('button', { name: /^选项/ }).click();
  const input = page.getByRole('textbox', { name: '问题（可选）', exact: true });
  await expect(input).toHaveValue('');
  await input.fill('一二三四五六七八九十一二三四五六七八九十多');
  await expect(input).toHaveValue('一二三四五六七八九十一二三四五六七八九十');
  const question = '你要往哪里走？';
  await input.fill(question);
  const play = page.getByRole('button', { name: '试玩 F5', exact: true });
  await play.click();
  const heading = page.getByRole('heading', { name: question, exact: true });
  await expect(heading).toHaveCount(0);
  const group = page.getByRole('group', { name: question, exact: true });
  await expect(group).toBeVisible();
  const option = group.locator('.player-choice').first();
  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(heading).toBeInViewport({ ratio: 1 });
    await expect(option).toBeInViewport({ ratio: 1 });
    const [headingBox, optionBox] = await Promise.all([
      heading.boundingBox(),
      option.boundingBox(),
    ]);
    expect(headingBox!.y + headingBox!.height).toBeLessThan(optionBox!.y);
    const [headingSize, optionSize] = await Promise.all(
      [heading, option.locator('strong')].map((locator) =>
        locator.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
      ),
    );
    expect(headingSize).toBeGreaterThan(optionSize);
  }
  await option.click();
  await expect(heading).toHaveCount(0);
});

test('slides storyboard text above the choices and sounds one cue when they appear', async ({
  page,
}) => {
  const project = testProject();
  const opening = project.scenes[0];
  const still = project.assets.find((asset) => asset.id === opening.assetId)!;
  still.type = 'image';
  still.path = 'test-media/primary.jpg';
  opening.timeline = {
    videoClips: [],
    stillClips: [{ id: 'opening-still', assetId: still.id, durationMs: 3000 }],
    audioClips: [],
  };
  opening.storyboardOverlay = true;
  opening.storyboardPages = [{ text: '林中亮起一盏灯。', durationMs: 3000 }];
  opening.choicesAtMs = 2000;
  opening.choiceQuestion = '你要往哪里走？';

  await page.addInitScript((value) => {
    localStorage.setItem('frameforge.project.v1', JSON.stringify(value));
    const startBuffer = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      const root = document.documentElement;
      root.dataset.choiceCues = String(Number(root.dataset.choiceCues ?? 0) + 1);
      root.dataset.choiceCueDurationMs = String(Math.round((this.buffer?.duration ?? 0) * 1000));
      startBuffer.apply(this, args);
    };
    const nativeStart = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (when) {
      document.dispatchEvent(new Event('player-cue-note'));
      nativeStart.call(this, when);
    };
    document.addEventListener('player-cue-note', () => {
      const root = document.documentElement;
      root.dataset.cueNotes = String(Number(root.dataset.cueNotes ?? 0) + 1);
    });
    document.addEventListener('transitionrun', (event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.matches('.player-storyboard-copy') &&
        event.propertyName === 'top'
      ) {
        document.documentElement.dataset.storyboardSlide = 'true';
      }
    });
  }, project);

  await page.goto('/');
  await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
  const copy = page.locator('.player-stage .player-storyboard-overlay .player-storyboard-copy');
  await expect(copy).toBeVisible();
  const before = (await copy.boundingBox())!.y;
  const root = page.locator('html');
  await expect(root).not.toHaveAttribute('data-choice-cues', /.+/);
  const group = page.getByRole('group', { name: opening.choiceQuestion });
  await expect(group).toBeVisible();
  await expect(root).toHaveAttribute('data-storyboard-slide', 'true');
  await expect(root).toHaveAttribute('data-choice-cues', '1');
  await expect(root).toHaveAttribute('data-choice-cue-duration-ms', '120');
  await expect(root).not.toHaveAttribute('data-cue-notes', /.+/);
  await expect.poll(async () => (await copy.boundingBox())!.y).toBeLessThan(before - 120);
  await expect(group.getByRole('heading')).toHaveCSS('font-size', '29px');

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(group).toBeVisible();
  await expect(root).toHaveAttribute('data-choice-cues', '1');
  await expect(root).not.toHaveAttribute('data-cue-notes', /.+/);
});
