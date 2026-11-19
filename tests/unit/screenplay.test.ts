import { expect, it } from 'vitest';
import { readScreenplayRoute } from '../../packages/agent/tools/screenplay';
import { createEditorTools } from '../../packages/agent/tools';
import { prepareGameProject } from '../../packages/export/project';
import { updateScreenplay } from '../../packages/domain/screenplay';
import { parseProject } from '../../packages/domain/schema';
import { testProject } from '../fixtures/project';
import type { StoryRouteStep } from '../../packages/agent/tools/route-simulation';

const choices = (...ids: string[]): StoryRouteStep[] =>
  ids.map((choiceId) => ({ action: 'choose', choiceId }));

it('reads selected chapter routes in runtime order, carrying the earlier chapter inventory', () => {
  const project = testProject();
  const second = 'chapter_gate';
  project.chapters.push({ id: second, title: '第二章', startNodeId: 'scene_branch' });
  for (const scene of project.scenes.slice(3)) scene.chapterId = second;
  const entry = updateScreenplay(project, 'scene_consume', [{ kind: 'sound', text: '石门闷响。' }]);
  const chosen = readScreenplayRoute(project, second, choices('choice_explore'));
  expect(chosen.rows.map(({ id }) => id)).toEqual(['scene_branch', 'scene_consume', 'scene_success']);
  expect(chosen.rows[0].target).toBe('消耗节点');
  expect(chosen.rows[1].entry).toEqual(entry);
  const declined = readScreenplayRoute(project, second, choices('choice_leave', 'choice_continue'));
  expect(declined.rows.map(({ id }) => id)).toEqual(['scene_branch', 'scene_neutral']);
  expect(readScreenplayRoute(project, second, []).decision?.chapterId).toBe('chapter_fixture');
  expect(readScreenplayRoute(project, second, [], true).rows.map(({ id }) => id)).toEqual([
    'scene_branch',
    'scene_neutral',
  ]);
  expect(
    readScreenplayRoute(project, 'chapter_fixture', choices('choice_explore')).chapterExited,
  ).toBe(true);
  expect(parseProject(project).screenplays).toEqual([entry]);
  expect(prepareGameProject(project).screenplays).toBeUndefined();
});

it('replays timed events while the screenplay reader waits on a continuing choice', () => {
  const project = testProject();
  const opening = project.scenes[0];
  opening.choiceMode = 'continue';
  opening.choices[0].condition = { kind: 'item', itemId: 'leaf', op: 'gte', count: 1 };
  opening.events = [
    {
      id: 'event_late_leaf',
      name: '拿到测试道具',
      trigger: 'time',
      atMs: 7500,
      once: true,
      effects: [{ kind: 'addItem', itemId: 'leaf', count: 1 }],
    },
  ];
  const first = readScreenplayRoute(project, opening.chapterId, []);
  expect(first.decision?.options[0].enabled).toBe(false);
  expect(first.decision?.remainingMs).toBe(3000);
  const waited = readScreenplayRoute(project, opening.chapterId, [
    { action: 'wait', durationMs: 3000 },
  ]);
  expect(waited.decision?.options[0].enabled).toBe(true);
  expect(waited.decision?.remainingMs).toBe(0);
});

it('reports net play time for the chosen route and paginates pacing by video visit', () => {
  const project = testProject();
  const opening = project.scenes[0];
  opening.choiceMode = 'continue';
  opening.storyboardOverlay = true;
  opening.storyboardPages = [{ text: '林中传来一阵响动。', durationMs: 8000 }];
  const registry = createEditorTools();
  const context = { project, selectedIds: [], activeChapterId: null, intents: [] };
  const inspect = (offset: number) =>
    registry.execute(
      'check_story',
      JSON.stringify({
        action: 'simulate',
        detail: 'pacing',
        steps: [
          { action: 'wait', durationMs: 1000 },
          { action: 'choose', choiceId: 'choice_explore' },
        ],
        offset,
        limit: 1,
      }),
      context,
    );
  const first = inspect(0);
  expect(first.ok, first.summary).toBe(true);
  expect(first.data).toMatchObject({
    ending: true,
    choices: 1,
    total: 3,
    playedMs: 18000,
    nextOffset: 1,
    truncated: true,
    chapters: [{ chapterId: opening.chapterId, playedMs: 18000, videoVisits: 3 }],
    rows: [
      {
        nodeId: opening.id,
        playedMs: 7000,
        playerText: { choiceBeforeTextEnd: true, mode: 'overlay' },
      },
    ],
  });
  expect(inspect(1).data).toMatchObject({
    playedMs: 18000,
    nextOffset: 2,
    rows: [{ nodeId: 'scene_reward', playedMs: 9000 }],
  });
  expect(inspect(2).data).toMatchObject({
    nextOffset: null,
    truncated: false,
    rows: [{ nodeId: 'scene_consume', playedMs: 2000 }],
  });
});
