import { test, expect } from './fixtures';
import { testProject } from '../fixtures/project';
import { clickPlayerAction } from './player-helpers';
import { saveGame, start } from '../../packages/runtime/engine';

test('a 480-node route opens its current chapter and fits the full flow without clipping', async ({
  page,
}) => {
  const project = testProject();
  const template = project.scenes[0];
  project.chapters = Array.from({ length: 19 }, (_, i) => ({
    id: `chapter_${i}`,
    title: `第${i + 1}章`,
    startNodeId: `large_${i * 25}`,
  }));
  project.scenes = Array.from({ length: 480 }, (_, i) => ({
    ...structuredClone(template),
    id: `large_${i}`,
    chapterId: `chapter_${Math.min(18, Math.floor(i / 25))}`,
    title: i === 474 ? '当前的线索' : `线索 ${i}`,
    kind: i === 479 ? ('ending' as const) : ('video' as const),
    nextId: i < 479 ? `large_${i + 1}` : '',
    choices: [],
    events: [],
  }));
  project.startNodeId = project.scenes[0].id;
  project.layout = Object.fromEntries(
    project.scenes.map((s, i) => [s.id, { x: (i % 25) * 380, y: Math.floor(i / 25) * 320 }]),
  );
  const state = start(project, 'large_474');
  state.visited = project.scenes.slice(0, 475).map(({ id }) => id);
  const slot = { title: '当前的线索', save: saveGame(project, state) };
  await page.addInitScript(
    ({ p, slot }) => {
      localStorage.setItem('frameforge.project.v1', JSON.stringify(p));
      localStorage.setItem(`frameforge.preview.save.${p.id}.0`, JSON.stringify(slot));
    },
    { p: project, slot },
  );
  await page.goto('/');
  await expect(page.getByLabel('当前章节')).toHaveValue('chapter_0');
  await expect(page.locator('.inspector-scene-title h2')).toHaveText('线索 0');
  await page.getByRole('button', { name: '试玩 F5', exact: true }).click();
  await clickPlayerAction(page, '存读档');
  await page.getByRole('tab', { name: '读档', exact: true }).click();
  await page.getByRole('button', { name: /01 当前的线索/ }).click();
  await clickPlayerAction(page, '剧情路线');
  await expect(page.getByLabel('路线章节')).toHaveValue('chapter_18');
  await page.getByLabel('路线章节').selectOption('chapter_0');
  await expect(page.locator('.route-graph-node')).toHaveCount(26);
  const canvas = page.getByRole('region', { name: '剧情流程图', exact: true });
  const legend = canvas.getByRole('group', { name: '路线图例', exact: true });
  await expect(legend).toBeVisible();
  expect((await canvas.boundingBox())!.height).toBeGreaterThan(page.viewportSize()!.height * 0.75);
  const chapterStart = page.locator('.route-graph-node[data-node-id="large_0"]');
  expect((await chapterStart.boundingBox())!.width).toBeGreaterThan(150);
  const readableViewport = await page.getByRole('region', { name: '剧情流程图' }).boundingBox();
  const readableNode = await chapterStart.boundingBox();
  expect(readableNode!.x).toBeGreaterThanOrEqual(readableViewport!.x);
  expect(readableNode!.x + readableNode!.width).toBeLessThanOrEqual(
    readableViewport!.x + readableViewport!.width,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('路线章节').selectOption('');
  await expect(page.locator('.route-graph-node')).toHaveCount(475);
  await page.getByRole('button', { name: '适应路线图', exact: true }).click();
  const viewport = await page.getByRole('region', { name: '剧情流程图' }).boundingBox();
  expect(viewport!.height).toBeGreaterThan(844 * 0.75);
  const legendBounds = (await legend.boundingBox())!;
  expect(legendBounds.x + legendBounds.width).toBeLessThanOrEqual(viewport!.x + viewport!.width);
  expect(legendBounds.y + legendBounds.height).toBeLessThanOrEqual(viewport!.y + viewport!.height);
  const first = await page.locator('.route-graph-node').first().boundingBox();
  const last = await page.locator('.route-graph-node').last().boundingBox();
  expect(first!.x).toBeGreaterThanOrEqual(viewport!.x - 1);
  expect(last!.x + last!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width + 1);
  await expect(page.locator('.route-graph-node[data-node-id="large_475"]')).toHaveCount(0);
  await page.getByRole('button', { name: '定位当前节点', exact: true }).click();
  await expect(page.locator('.route-graph-node.current')).toContainText('当前的线索');
  expect((await page.locator('.route-graph-node.current').boundingBox())!.width).toBeGreaterThan(
    150,
  );
  await page.screenshot({ path: '.local/route-large-portrait.png' });
});
