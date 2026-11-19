import { expect, it } from 'vitest';
import { fingerprint, loadGame, saveGame, start } from '../../packages/runtime/engine';
import { prepareGameProject } from '../../packages/export/project';
import { updateDesign } from '../../packages/domain/story-design';
import { createEditorTools } from '../../packages/agent/tools';
import {
  makeChoice,
  makeProject,
  makeScene,
  parseProject,
  type Project,
} from '../../packages/domain/schema';

function fixture() {
  const project = makeProject();
  const opening = project.scenes[0];
  const next = makeScene('video', 2, opening.chapterId);
  const gate = makeScene('branch', 3, opening.chapterId);
  const fallback = makeScene('ending', 4, opening.chapterId);
  const target = makeScene('video', 5, opening.chapterId);
  const ending = makeScene('ending', 6, opening.chapterId);
  opening.storyboardPages = [{ text: '开场对白', durationMs: 3000 }];
  opening.nextId = next.id;
  next.choices = [{ ...makeChoice('继续'), targetId: gate.id }];
  project.variables = [{ id: 'signal', name: '信号', type: 'boolean', initial: false }];
  next.events = [
    {
      id: 'event_signal',
      name: '设置信号',
      trigger: 'time',
      atMs: 1000,
      once: true,
      effects: [{ kind: 'setVariable', variableId: 'signal', value: true }],
    },
  ];
  gate.choices = [
    {
      ...makeChoice(),
      targetId: target.id,
      condition: { kind: 'variable', variableId: 'signal', op: 'eq', value: true },
    },
    { ...makeChoice(), targetId: fallback.id },
  ];
  target.nextId = ending.id;
  target.notes = '作者备注';
  const asset = (id: string, type: Project['assets'][number]['type']) => ({
    id,
    type,
    name: `${id} 文件`,
    path: id,
    size: 1,
    durationMs: 4000,
    width: 1,
    height: 1,
    builtin: false,
  });
  project.assets = [asset('voice', 'audio'), asset('frame', 'image')];
  target.timeline = {
    videoClips: [],
    stillClips: [{ id: 'still', assetId: 'frame', durationMs: 4000 }],
    audioClips: [
      {
        id: 'audio',
        assetId: 'voice',
        startMs: 500,
        durationMs: 2000,
        trimStartMs: 0,
        trimEndMs: 2000,
        volume: 1,
        loop: false,
        role: 'dialogue',
      },
    ],
  };
  project.productionShots = [
    {
      id: 'shot',
      nodeId: target.id,
      label: 'S01',
      durationMs: 4000,
      action: '推开门',
      audio: '你终于来了',
    },
  ];
  project.scenes = [fallback, target, ending, next, opening, gate];
  const registry = createEditorTools();
  const read = (query: object, readPageCharacters?: number) =>
    registry.execute('read_story', JSON.stringify({ action: 'playback', ...query }), {
      project,
      selectedIds: [],
      activeChapterId: null,
      intents: [],
      readPageCharacters,
    });
  return { project, opening, next, gate, target, ending, read };
}

it('reads a single window in runtime order with actual branch evaluation and media timings', () => {
  const { opening, next, gate, target, ending, read } = fixture();
  const result = read({
    nodeIds: [target.id, opening.id],
    choiceIds: [next.choices[0].id],
    before: 1,
    after: 1,
  });
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    stop: 'window',
    unreachedNodeIds: [],
    truncated: false,
    nextOffset: null,
    nodes: [
      {
        id: opening.id,
        target: true,
        storyboardPlays: true,
        storyboardPages: opening.storyboardPages,
      },
      { id: next.id, target: false },
      { id: gate.id, target: false },
      {
        id: target.id,
        target: true,
        notes: target.notes,
        shots: [{ id: 'shot', action: '推开门', audio: '你终于来了' }],
        timeline: {
          durationMs: 4000,
          dialogueEndMs: 2500,
          still: [{ assetName: 'frame 文件', startMs: 0, endMs: 4000 }],
          audio: [{ assetName: 'voice 文件', role: 'dialogue', startMs: 500, endMs: 2500 }],
        },
      },
      { id: ending.id, target: false },
    ],
  });
});

it('lets the Agent toggle storyboard text over images while keeping media duration', () => {
  const { project, next, target } = fixture();
  target.storyboardPages = [{ text: '场景旁白', durationMs: 6000 }];
  const registry = createEditorTools();
  const context = { project, selectedIds: [target.id], activeChapterId: null, intents: [] };
  for (const enabled of [true, false]) {
    const result = registry.execute(
      'edit_scene',
      JSON.stringify({
        action: 'update',
        nodeId: target.id,
        patch: { storyboardOverlay: enabled },
      }),
      context,
    );
    expect(result.ok).toBe(true);
    expect(
      registry.execute(
        'read_story',
        JSON.stringify({
          action: 'playback',
          nodeIds: [target.id],
          choiceIds: [next.choices[0].id],
          before: 0,
          after: 0,
        }),
        context,
      ).data,
    ).toMatchObject({
      nodes: [{ storyboardPlays: enabled, timeline: { durationMs: 4000 } }],
    });
  }
});

it('stops at an unspecified player choice and reports missing targets', () => {
  const { opening, next, target, read } = fixture();
  expect(read({ count: 3 }).data).toMatchObject({
    stop: 'choice',
    stopNodeId: next.id,
    nodes: [{ id: opening.id }, { id: next.id }],
    choices: [{ id: next.choices[0].id, enabled: true }],
  });
  expect(read({ nodeIds: [target.id] }).data).toMatchObject({
    stop: 'choice',
    nodes: [],
    unreachedNodeIds: [target.id],
  });
  expect(read({ nodeIds: ['missing'] }).ok).toBe(false);
});

it('paginates complete nodes and identifies a node whose details alone exceed the budget', () => {
  const { opening, next, read } = fixture();
  next.notes = '长'.repeat(3000);
  expect(read({ count: 2 }, 1200).data).toMatchObject({
    truncated: true,
    nextOffset: 1,
    omittedDetails: false,
    nodes: [{ id: opening.id }],
  });
  expect(read({ count: 2, offset: 1 }, 1200).data).toMatchObject({
    truncated: true,
    nextOffset: null,
    omittedDetails: true,
    nodes: [{ id: next.id, detailsOmitted: true }],
  });
});

it('reads a chapter or individual scene without storing a source link on nodes', () => {
  const { project, opening } = fixture();
  const target = { stage: 'chapter' as const, chapterId: opening.chapterId };
  updateDesign(
    project,
    target,
    '# 第一章\n\n## 场次 A 门外\n听见敲门。\n```md\n## 场次 fake 假标题\n```\n\n## 场次 B 屋内\n窗没有关。',
    false,
  );
  const notes = [
    '从哪来｜第一章开场。',
    '已知与持有｜在门内，没有钥匙。',
    '这一段新增什么｜听见门外敲门。',
    '往哪去｜接入下一节点，去门口。',
  ].join('\n');
  opening.notes = notes;

  const registry = createEditorTools();
  const context = { project, selectedIds: [], activeChapterId: null, intents: [] };
  const call = (tool: string, args: object) =>
    registry.execute(tool, JSON.stringify(args), context);
  expect(
    call('read_story', { action: 'read', nodeId: opening.id, section: 'notes' }).data,
  ).toMatchObject({ chapterId: opening.chapterId, notes });
  expect(call('read_story_design', { target }).data).toMatchObject({
    text: expect.stringContaining('## 场次 B 屋内'),
  });
  expect(call('read_story_design', { target, sceneKey: 'A', limit: 6 }).data).toMatchObject({
    sceneKey: 'A',
    nextOffset: 6,
    scriptSceneStatus: 'linked',
  });
  const rest = call('read_story_design', { target, sceneKey: 'A', offset: 6 }).data;
  expect(rest).toMatchObject({ text: expect.stringContaining('听见敲门。'), nextOffset: null });
  expect(rest).toMatchObject({ text: expect.not.stringContaining('窗没有关。') });
  expect(call('read_story_design', { target, sceneKey: 'fake' }).data).toMatchObject({
    scriptSceneStatus: 'missing',
  });
  updateDesign(project, target, '## 场次 A 前\n前。\n## 场次 A 后\n后。', false);
  expect(call('read_story_design', { target, sceneKey: 'A' }).data).toMatchObject({
    scriptSceneStatus: 'duplicate',
  });
  expect(JSON.stringify(registry.specs().find(({ name }) => name === 'edit_scene'))).not.toContain(
    'scriptSceneRef',
  );
});

it('ignores obsolete source links when opening older projects without breaking saves', () => {
  const { project, opening } = fixture();
  opening.notes = '已有节点内容照常保留。';
  const legacy = {
    ...project,
    scenes: project.scenes.map((scene) =>
      scene.id === opening.id
        ? { ...scene, scriptSceneRef: { chapterId: 'old-chapter', sceneKey: 'A' } }
        : scene,
    ),
  };
  const parsed = parseProject(legacy);
  const original = parseProject(project);
  const node = parsed.scenes.find(({ id }) => id === opening.id)!;
  expect(node).not.toHaveProperty('scriptSceneRef');
  expect(node.notes).toBe(opening.notes);
  expect(parsed).toEqual(original);
  expect(fingerprint(parsed)).toBe(fingerprint(original));
  const saved = saveGame(original, start(original));
  expect(loadGame(parsed, saved)).toEqual(saved.state);
  expect(prepareGameProject(parsed).scenes.find(({ id }) => id === opening.id)).toMatchObject({
    notes: '',
  });
});

it('appends only explicitly chosen frames, reports actual text timings and rolls back rejected additions', () => {
  const { project, opening, target } = fixture();
  const shot = project.productionShots![0];
  shot.firstFrameAssetId = 'frame';
  shot.durationMs = 1000;
  target.storyboardPages = [{ text: '门把动了。', durationMs: 9000 }];
  target.storyboardOverlay = true;
  target.choices = [{ ...makeChoice(), targetId: target.nextId }];
  target.choicesAtMs = 4200;
  const registry = createEditorTools();
  const context = { project, selectedIds: [], activeChapterId: null, intents: [] };
  const append = (nodeId: string, frame: 'first' | 'last') =>
    registry.execute(
      'edit_timeline',
      JSON.stringify({ nodeId, command: { action: 'append_shot_frame', shotId: shot.id, frame } }),
      context,
    );
  const before = structuredClone(project);
  expect(append(opening.id, 'first').ok).toBe(false);
  expect(append(target.id, 'last').ok).toBe(false);
  expect(context.project).toEqual(before);
  const result = append(target.id, 'first');
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    clipId: expect.any(String),
    playerTextPlayback: {
      mode: 'overlay',
      effectiveDurationMs: 5000,
      compressed: true,
      choiceAtMs: 4200,
      choiceBeforeTextEnd: true,
    },
  });
  const updated = context.project.scenes.find(({ id }) => id === target.id);
  expect(updated?.timeline?.audioClips).toEqual(
    before.scenes.find(({ id }) => id === target.id)?.timeline?.audioClips,
  );
  expect(updated?.timeline?.stillClips?.[1]).toMatchObject({ assetId: 'frame', durationMs: 1000 });
  expect(
    registry.execute(
      'read_story',
      JSON.stringify({ action: 'playback', fromNodeId: target.id, count: 1 }),
      context,
    ).data,
  ).toMatchObject({
    nodes: [{ playerTextPlayback: { mode: 'overlay', effectiveDurationMs: 5000 } }],
  });
});
