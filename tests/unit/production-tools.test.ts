import { expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { requestPlanSchema } from '../../packages/agent/request-plan';
import { runAgent } from '../fixtures/agent-intent';
import { createEditorTools } from '../../packages/agent/tools';
import { newSession, type ModelFrame, type ToolContext } from '../../packages/agent/types';
import { assetInUse } from '../../packages/domain/assets';
import { mergeProjectEdits } from '../../packages/domain/project-merge';
import {
  makeChoice,
  makeProject,
  makeScene,
  parseProject,
  type Asset,
} from '../../packages/domain/schema';
import { validateProject } from '../../packages/domain/validation';
import { prepareGameProject } from '../../packages/export/project';
import { fingerprint } from '../../packages/runtime/engine';

const tools = createEditorTools();
const contextFor = (project = makeProject()): ToolContext => ({
  project,
  selectedIds: [],
  activeChapterId: null,
  intents: [],
});
const call = (context: ToolContext, name: string, input: object) =>
  tools.execute(name, JSON.stringify(input), context);
const doorFrame = {
  framing: '齐胸高的斜侧近景，对焦门把。',
  space: '门板占画面右侧，画左只露门厅墙面。',
  subject: '右手搭在金属门把上，门缝合拢。',
  lighting: '画左的顶灯照亮门把磨痕。',
};

function asset(id: string, type: Asset['type']): Asset {
  return {
    id,
    type,
    name: id,
    path: `assets/${id}`,
    size: 1,
    durationMs: 4000,
    width: 1,
    height: 1,
    builtin: false,
  };
}

it('persists ordered shot cards across reloads, merges independent edits and keeps them out of playback', () => {
  const original = makeProject();
  const nodeId = original.startNodeId;
  original.assets = [asset('frame', 'image'), asset('video', 'video')];
  const context = contextFor(original);
  const create = (label: string, fields = {}) =>
    call(context, 'edit_production_shot', {
      action: 'create',
      nodeId,
      label,
      durationMs: 4000,
      ...fields,
    });
  const one = create('S01', { firstFrameAssetId: 'frame', endState: '左手扣住窗把' });
  const two = create('S02', { index: 0, firstFramePrompt: '右手下垂' });
  expect(one.ok).toBe(true);
  expect(two.ok).toBe(true);
  expect(create('s01').ok).toBe(false);
  expect(create('S03', { firstFrameAssetId: 'video' }).ok).toBe(false);
  expect(assetInUse(context.project, 'frame')).toBe(true);
  expect(call(context, 'delete_asset', { assetId: 'frame' }).ok).toBe(false);

  const saved = parseProject(JSON.parse(JSON.stringify(context.project)));
  const secondRun = contextFor(saved);
  const listing = call(secondRun, 'read_story', { action: 'shots', nodeId, limit: 1 });
  expect(listing.data).toMatchObject({ total: 2, nextOffset: 1, shots: [{ label: 'S02' }] });
  expect(call(secondRun, 'read_story', { action: 'shots', nodeId, offset: 1 }).data).toMatchObject({
    nextOffset: null,
    shots: [{ label: 'S01' }],
  });
  const { shotId } = one.data as { shotId: string };
  expect(call(secondRun, 'read_story', { action: 'shot', shotId }).data).toMatchObject({
    id: shotId,
    endState: '左手扣住窗把',
  });
  expect(
    call(secondRun, 'edit_production_shot', {
      action: 'update',
      shotId,
      patch: { videoAssetId: 'video' },
    }).ok,
  ).toBe(true);
  const userEdit = structuredClone(saved);
  userEdit.scenes[0].notes = '用户编辑的备注';
  const merged = mergeProjectEdits(saved, userEdit, secondRun.project);
  expect(merged).toHaveProperty('project');
  if (!('project' in merged)) throw new Error(merged.error);
  expect(merged.project.productionShots?.[1]).toMatchObject({
    id: shotId,
    endState: '左手扣住窗把',
    videoAssetId: 'video',
  });
  expect(merged.project.scenes[0]).toMatchObject({ notes: '用户编辑的备注' });
  const game = prepareGameProject(merged.project);
  expect(game.productionShots).toBeUndefined();
  expect(fingerprint(merged.project)).toBe(fingerprint(original));
  expect(game.scenes[0].storyboardPages).toBe(original.scenes[0].storyboardPages);
  expect(validateProject(merged.project).filter((issue) => issue.severity === 'error')).toEqual(
    validateProject(original).filter((issue) => issue.severity === 'error'),
  );
  expect(call(secondRun, 'delete_scene', { nodeId }).ok).toBe(true);
  expect(secondRun.project.productionShots).toBeUndefined();
  expect(assetInUse(secondRun.project, 'frame')).toBe(false);
});

it('separates the shot action from the creation operation and accepts legacy action prose', () => {
  const context = contextFor();
  const nodeId = context.project.startNodeId;
  const first = { nodeId, label: 'S01', durationMs: 3500 };
  const second = { nodeId, label: 'S02', durationMs: 2500 };
  expect(
    call(context, 'edit_production_shot', {
      ...first,
      action: 'create',
      shotAction: '他从枕头上抬起眼睛',
    }).ok,
  ).toBe(true);
  expect(
    call(context, 'edit_production_shot', {
      ...second,
      action: '她轻轻把病房的门推开',
    }).ok,
  ).toBe(true);
  expect(
    call(context, 'edit_production_shot', {
      ...second,
      label: 'S03',
      action: 'remove',
    }).ok,
  ).toBe(false);
  expect(context.project.productionShots?.map(({ action }) => action)).toEqual([
    '他从枕头上抬起眼睛',
    '她轻轻把病房的门推开',
  ]);
});

it('saves a structured frame prompt and requires explicit visual content for the requested frame', async () => {
  const context = contextFor();
  const generateShotImage = vi.fn<
    NonNullable<NonNullable<ToolContext['media']>['generateShotImage']>
  >(async () => asset('structured-frame', 'image'));
  context.media = { generateShotImage };
  context.signal = new AbortController().signal;
  const created = call(context, 'edit_production_shot', {
    action: 'create',
    nodeId: context.project.startNodeId,
    label: 'S01',
    durationMs: 3000,
    shotAction: '拉下把手，门向里打开。',
    endState: '门开了。',
    firstFramePrompt: { ...doorFrame, exclusions: '门缝内无光。' },
  });
  expect(created.ok).toBe(true);
  const { shotId } = created.data as { shotId: string };
  const readFrame = () =>
    call(context, 'read_story', { action: 'shot', shotId, section: 'prompts' }).data;
  const generate = (input: object) =>
    tools.executeAsync('generate_shot_image', JSON.stringify({ shotId, ...input }), context);
  const expected = [
    '【取景与构图】齐胸高的斜侧近景，对焦门把。',
    '【空间】门板占画面右侧，画左只露门厅墙面。',
    '【主体与状态】右手搭在金属门把上，门缝合拢。',
    '【光线与质感】画左的顶灯照亮门把磨痕。',
    '【画面限制】门缝内无光。',
  ].join('\n');
  expect(readFrame()).toMatchObject({ firstFramePrompt: expected });
  expect(await generate({ frame: 'last' })).toMatchObject({
    ok: false,
    summary: expect.stringContaining('尾帧'),
  });
  expect(await generate({ prompt: { framing: doorFrame.framing } })).toMatchObject({ ok: false });
  expect(generateShotImage).not.toHaveBeenCalled();
  expect(await generate({})).toMatchObject({ ok: true });
  expect(generateShotImage.mock.calls[0][1]).toMatchObject({ prompt: expected });

  const temporary = { ...doorFrame, subject: '右手已离开门把，门停在半开位置。' };
  expect(await generate({ frame: 'last', prompt: temporary })).toMatchObject({ ok: true });
  expect(generateShotImage.mock.calls[1][1]).toMatchObject({
    frame: 'last',
    prompt: expect.stringContaining(temporary.subject),
  });
  expect(readFrame()).not.toHaveProperty('lastFramePrompt', expect.any(String));
  expect(
    call(context, 'edit_production_shot', {
      action: 'update',
      shotId,
      patch: { lastFramePrompt: temporary },
    }).ok,
  ).toBe(true);
  expect(readFrame()).toMatchObject({
    firstFramePrompt: expected,
    lastFramePrompt: expect.stringContaining(`【主体与状态】${temporary.subject}`),
  });
});

it('saves and forwards frame prompts up to 8000 characters', async () => {
  const context = contextFor();
  context.project.assets = [asset('wardrobe', 'image')];
  context.project.worldSettings = [
    { id: 'actor', kind: 'character', name: '演员', imageAssetId: 'wardrobe' },
  ];
  const firstFramePrompt = '雨中全景'.repeat(2000);
  const lastFramePrompt = '冷光近景'.repeat(2000);
  const created = call(context, 'edit_production_shot', {
    action: 'create',
    nodeId: context.project.startNodeId,
    label: 'S01',
    durationMs: 4000,
    firstFramePrompt,
  });
  expect(created.ok).toBe(true);
  const { shotId } = created.data as { shotId: string };
  const update = (prompt: string) =>
    call(context, 'edit_production_shot', {
      action: 'update',
      patch: { shotId, lastFramePrompt: prompt, settingIds: ['actor'] },
    });
  expect(update(lastFramePrompt).ok).toBe(true);
  expect(update(lastFramePrompt + '雨').ok).toBe(false);
  const tone = '低饱和钢灰，暖色仅来自场景内实际暖光。';
  expect(call(context, 'update_project', { atmosphereTone: tone }).ok).toBe(true);
  const videoPrompt = '固定机位，缓慢推窗。';
  expect(
    call(context, 'edit_production_shot', { action: 'update', shotId, patch: { videoPrompt } }).ok,
  ).toBe(false);
  context.project.productionShots![0].videoPrompt = videoPrompt;

  const parsed = contextFor(parseProject(JSON.parse(JSON.stringify(context.project))));
  expect(parsed.project.productionShots).toMatchObject([{ firstFramePrompt, lastFramePrompt }]);
  const generateShotImage = vi.fn(async () => asset('long-prompt-frame', 'image'));
  parsed.media = { generateShotImage };
  parsed.signal = new AbortController().signal;
  const generated = await tools.executeAsync(
    'generate_shot_image',
    JSON.stringify({ shotId, frame: 'last' }),
    parsed,
  );
  expect(generated.ok, generated.summary).toBe(true);
  expect(generateShotImage).toHaveBeenCalledWith(
    parsed.project.id,
    expect.objectContaining({
      prompt: lastFramePrompt,
      atmosphereTone: tone,
      references: [{ assetId: 'wardrobe', name: '演员' }],
    }),
    parsed.signal,
    expect.any(String),
  );
  const readVideo = () =>
    call(parsed, 'read_story', { action: 'shot', shotId, section: 'video' }).data;
  expect(readVideo()).not.toHaveProperty('videoPrompt');
  expect(parsed.project.productionShots?.[0].videoPrompt).toBe(videoPrompt);
  expect(prepareGameProject(parsed.project).settings.atmosphereTone).toBeUndefined();
  expect(call(parsed, 'update_project', { atmosphereTone: null }).ok).toBe(true);
  expect(readVideo()).not.toHaveProperty('videoPromptForGeneration');
});

it('uses runtime conditions, complete events and manual choices with paged route traces', () => {
  const context = contextFor();
  const { project } = context;
  const opening = project.scenes[0];
  const payoff = makeScene('video', 2);
  const automatic = makeScene('branch', 3);
  const ending = makeScene('ending', 4);
  project.scenes.push(payoff, automatic, ending);
  project.variables.push({
    id: 'trust',
    name: '信任',
    type: 'number',
    initial: 0,
    min: 0,
    max: 3,
    hidden: true,
  });
  project.items.push({ id: 'key', name: '钥匙', description: '', initial: 0 });
  opening.choicesAtMs = 0;
  opening.choiceMode = 'continue';
  const option = {
    ...makeChoice('交出钥匙'),
    targetId: payoff.id,
    condition: {
      kind: 'all' as const,
      children: [
        { kind: 'variable' as const, variableId: 'trust', op: 'gte' as const, value: 2 },
        { kind: 'item' as const, itemId: 'key', op: 'gte' as const, count: 1 },
      ],
    },
  };
  opening.choices = [option];
  opening.events = [
    {
      id: 'chime',
      name: '提示',
      trigger: 'time',
      atMs: 700,
      once: true,
      effects: [{ kind: 'addVariable', variableId: 'trust', value: 1 }],
    },
  ];
  payoff.events = [
    {
      id: 'spend',
      name: '消耗',
      trigger: 'complete',
      atMs: 0,
      once: true,
      effects: [{ kind: 'removeItem', itemId: 'key', count: 1 }],
    },
  ];
  payoff.nextId = automatic.id;
  automatic.choices = [{ ...makeChoice('转入结局'), targetId: ending.id }];
  const simulate = (input: object) =>
    call(context, 'check_story', { action: 'simulate', ...input });
  expect(
    simulate({ initialVariables: { trust: 0 }, initialInventory: { key: 1 } }).data,
  ).toMatchObject({ choices: [{ enabled: false }] });
  expect(
    simulate({ initialVariables: { trust: 2 }, initialInventory: { key: 1 } }).data,
  ).toMatchObject({ choices: [{ enabled: true }] });
  expect(simulate({ initialVariables: { trust: 99 } }).ok).toBe(false);
  const args = {
    initialVariables: { trust: 1 },
    initialInventory: { key: 1 },
    steps: [
      { action: 'wait', durationMs: 1500 },
      { action: 'choose', choiceId: option.id },
    ],
    limit: 2,
  };
  expect(simulate(args).data).toMatchObject({
    nodeId: ending.id,
    inventory: { key: 0 },
    variables: { trust: 2 },
    nextOffset: 2,
    visitedNodeIds: [opening.id, payoff.id, automatic.id, ending.id],
    traceComplete: true,
    trace: [
      { action: 'start' },
      { action: 'wait', variables: [{ id: 'trust', before: 1, after: 2 }] },
    ],
  });
  expect(simulate({ ...args, offset: 2, limit: 3 }).data).toMatchObject({
    nextOffset: null,
    trace: [
      { action: 'wait', phase: 'choosing' },
      { action: 'choose', enteredNodeIds: [payoff.id] },
      {
        enteredNodeIds: [automatic.id, ending.id],
        inventory: [{ id: 'key', before: 1, after: 0 }],
      },
    ],
  });
  expect(project.variables[0].initial).toBe(0);
  expect(project.items[0].initial).toBe(0);
});

it('exposes desktop media tools through the host and commits generated and selected assets together', async () => {
  const project = makeProject();
  project.worldSettings = [
    { id: 'station', kind: 'location', name: '站台', visual: '白色灯光与湿地面' },
  ];
  const generateReference = vi.fn(async () => asset('generated-frame', 'image'));
  const importAssets = vi.fn(async () => [asset('chosen-video', 'video')]);
  const frames: ModelFrame[] = [
    {
      text: '',
      finish: 'complete',
      raw: {},
      calls: [
        {
          id: 'generate',
          name: 'generate_world_reference',
          arguments: '{"settingId":"station","kind":"image"}',
        },
      ],
    },
    {
      text: '',
      finish: 'complete',
      raw: {},
      calls: [
        {
          id: 'import',
          name: 'import_assets',
          arguments: '{}',
        },
      ],
    },
    { text: '已生成并导入。', finish: 'complete', raw: {}, calls: [] },
  ];
  const commit = vi.fn(() => true);
  const signal = new AbortController().signal;
  const result = await runAgent({
    session: newSession(project.id),
    user: '生成站台参考图并导入我选择的视频',
    plan: { kind: 'execute', externalActions: ['image', 'import'] },
    provider: 'deepseek',
    model: 'test',
    project,
    selectedIds: [],
    activeChapterId: null,
    registry: tools,
    media: { generateReference, importAssets },
    signal,
    runId: 'run_media',
    commit,
    onEvent: () => {},
    client: async ({ tools }) => {
      expect(tools.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['generate_world_reference', 'import_assets']),
      );
      return frames.shift()!;
    },
  });
  expect(result.turn.status, result.turn.error).toBe('completed');
  expect(generateReference).toHaveBeenCalledOnce();
  expect(importAssets).toHaveBeenCalledOnce();
  expect(commit).toHaveBeenCalledOnce();
  expect(commit).toHaveBeenCalledWith(
    project,
    expect.objectContaining({
      assets: [
        expect.objectContaining({ id: 'generated-frame' }),
        expect.objectContaining({ id: 'chosen-video' }),
      ],
      worldSettings: [expect.objectContaining({ id: 'station', imageAssetId: 'generated-frame' })],
    }),
    [],
    expect.any(Function),
  );
  expect(project.assets).toEqual([]);
});

it('commits each shot image before generating the next image in the same response', async () => {
  const context = contextFor();
  const nodeId = context.project.startNodeId;
  for (const label of ['S01', 'S02']) {
    expect(
      call(context, 'edit_production_shot', {
        action: 'create',
        nodeId,
        label,
        durationMs: 4000,
        camera: label,
        firstFramePrompt: doorFrame,
      }).ok,
    ).toBe(true);
  }
  const project = context.project;
  const [first, second] = project.productionShots!;
  const commit = vi.fn((_base: typeof project, _draft: typeof project) => true);
  const generateShotImage = vi
    .fn()
    .mockResolvedValueOnce(asset('first-image', 'image'))
    .mockImplementationOnce(async () => {
      expect(commit).toHaveBeenCalledOnce();
      expect(commit.mock.calls[0][1].productionShots?.[0].firstFrameAssetId).toBe('first-image');
      return asset('second-image', 'image');
    });
  const frames: ModelFrame[] = [
    {
      text: '',
      raw: {},
      finish: 'complete',
      calls: [first, second].map(({ id }) => ({
        id,
        name: 'generate_shot_image',
        arguments: JSON.stringify({ shotId: id }),
      })),
    },
    { text: '已生成。', raw: {}, finish: 'complete', calls: [] },
  ];
  const result = await runAgent({
    session: newSession(project.id),
    user: '生成这两个镜头的分镜图',
    plan: { kind: 'execute', externalActions: ['image'] },
    provider: 'deepseek',
    model: 'test',
    project,
    selectedIds: [nodeId],
    activeChapterId: null,
    registry: tools,
    media: { generateShotImage },
    liveUpdates: true,
    signal: new AbortController().signal,
    runId: 'shot-batch',
    commit,
    onEvent: () => {},
    client: async () => frames.shift()!,
  });
  expect(result.turn.status, result.turn.error).toBe('completed');
  expect(generateShotImage).toHaveBeenCalledTimes(2);
  expect(commit).toHaveBeenCalledTimes(2);
  expect(commit.mock.calls[1][1].productionShots?.map((shot) => shot.firstFrameAssetId)).toEqual([
    'first-image',
    'second-image',
  ]);
});

it('runs independent MiniMax jobs in parallel and commits only successful bindings in one change', async () => {
  const project = makeProject();
  const nodeId = project.startNodeId;
  project.settings = {
    ...project.settings,
    width: 1080,
    height: 1920,
    artStyle: { preset: 'anime', description: '水彩' },
  };
  project.assets = [asset('character', 'image'), asset('room', 'image')];
  project.worldSettings = [
    { id: 'actor', kind: 'character', name: '林远', visual: '灰色外套' },
    { id: 'location', kind: 'location', name: '站台', visual: '昏暗隧道' },
  ];
  project.productionShots = [{ id: 'shot', nodeId, label: '01', durationMs: 3000, camera: '回头' }];
  const jobs = [
    { target: 'setting', settingId: 'actor', imageAspect: '3:4', referenceAssetIds: ['character'] },
    { target: 'shot', shotId: 'shot', referenceAssetIds: ['character', 'room'], prompt: doorFrame },
    { target: 'setting', settingId: 'location' },
    { target: 'shot', shotId: 'shot' },
  ];
  let started = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begin = async () => {
    if (++started === 3) release();
    await barrier;
  };
  const generateReference = vi.fn<
    NonNullable<NonNullable<ToolContext['media']>['generateReference']>
  >(async (_id, request) => {
    await begin();
    if (request.settingKind === 'location') throw new Error('MiniMax 生图失败：触发限流');
    expect(request).toMatchObject({ imageAspect: '3:4', references: [{ assetId: 'character' }] });
    return asset('definition', 'image');
  });
  const generateShotImage = vi.fn<
    NonNullable<NonNullable<ToolContext['media']>['generateShotImage']>
  >(async (_id, request) => {
    await begin();
    expect(request).toMatchObject({
      aspect: 'portrait',
      artStyle: project.settings.artStyle,
      references: [{ assetId: 'character' }, { assetId: 'room' }],
      prompt: expect.stringContaining(doorFrame.subject),
    });
    return asset('first-frame', 'image');
  });
  const commit = vi.fn((_base: typeof project, _draft: typeof project) => true);
  let rounds = 0;
  const result = await runAgent({
    session: newSession(project.id),
    user: '批量生成角色设定图、场景图和分镜图',
    plan: { kind: 'execute', externalActions: ['image'] },
    provider: 'deepseek',
    model: 'test',
    project,
    selectedIds: [nodeId],
    activeChapterId: null,
    registry: tools,
    media: { imageProvider: 'minimax', generateReference, generateShotImage },
    liveUpdates: true,
    signal: AbortSignal.timeout(2000),
    runId: 'minimax-batch',
    commit,
    onEvent: () => {},
    client: async (request) => {
      if (rounds++ === 0) {
        expect(request.tools.map(({ name }) => name)).toContain('generate_image_batch');
        return {
          text: '',
          raw: {},
          finish: 'complete',
          calls: [
            { id: 'batch', name: 'generate_image_batch', arguments: JSON.stringify({ jobs }) },
          ],
        };
      }
      expect(request.exchanges.at(-1)?.replies.at(-1)?.result.data).toMatchObject({
        items: [
          { ok: true },
          { ok: true },
          { ok: false, summary: expect.stringContaining('限流') },
          { ok: false, summary: expect.stringContaining('相同') },
        ],
      });
      return { text: '两张已绑定，一张限流。', raw: {}, finish: 'complete', calls: [] };
    },
  });
  expect(result.turn.status, result.turn.error).toBe('completed');
  expect(started).toBe(3);
  expect(commit).toHaveBeenCalledOnce();
  const [, updated] = commit.mock.calls[0];
  expect(updated.worldSettings).toMatchObject([{ imageAssetId: 'definition' }, { id: 'location' }]);
  expect(updated.productionShots).toMatchObject([{ firstFrameAssetId: 'first-frame' }]);
  expect(project.assets.map(({ id }) => id)).toEqual(['character', 'room']);
});

it('runs authored script, playable text, shot generation, explicit placement and text revision as separate Agent turns', async () => {
  let project = makeProject();
  const nodeId = project.startNodeId;
  const chapterId = project.chapters[0].id;
  const target = { stage: 'chapter', chapterId };
  const generated = vi.fn(async () => asset('banked-frame', 'image'));
  const context = (name: string, args: object) => ({
    id: name,
    name,
    arguments: JSON.stringify(args),
  });
  const run = async (
    requestText: string,
    calls: ModelFrame['calls'],
    plan: z.input<typeof requestPlanSchema> = { kind: 'execute' },
  ) => {
    let submitted = 0;
    const result = await runAgent({
      project,
      selectedIds: [nodeId],
      activeChapterId: chapterId,
      session: newSession(project.id),
      user: requestText,
      provider: 'deepseek',
      model: 'test',
      runId: 'run_production_contract',
      signal: AbortSignal.timeout(3000),
      registry: tools,
      media: { imageProvider: 'minimax', generateShotImage: generated },
      plan,
      commit: (_base, draft) => {
        project = draft;
        submitted++;
        return true;
      },
      onEvent: () => {},
      client: async ({ exchanges }) =>
        !exchanges.length
          ? {
              text: '',
              raw: {},
              finish: 'complete',
              calls,
            }
          : {
              text: '本轮已完成。',
              raw: {},
              finish: 'complete',
              calls: [],
            },
    });
    expect(result.turn.status, result.turn.error).toBe('completed');
    expect(submitted).toBe(1);
    return result.turn;
  };
  await run(
    '只保存本章剧本',
    [context('edit_story_design', { target, text: '## 场次 1-1 门外\n我听见三声敲门。' })],
    { kind: 'execute', design: { chapter: true, chapters: { kind: 'active' } } },
  );
  expect(project.productionShots).toBeUndefined();
  expect(project.scenes[0].storyboardPages).toBeUndefined();
  const notes =
    '从哪来｜开场。\n已知与持有｜独自在家。\n这一段新增什么｜听见敲门。\n往哪去｜走向门口。';
  const originalPages = [{ text: '门外响起三声。我认得这个节奏。', durationMs: 5000 }];
  await run('用玩家文字搭建当前节点的试玩', [
    context('edit_scene', {
      action: 'update',
      nodeId,
      patch: { notes, storyboardPages: originalPages },
    }),
  ]);
  expect(project.scenes[0].storyboardPages).toEqual(originalPages);
  expect(project.productionShots).toBeUndefined();
  await run('只写当前节点静帧的制作镜头和提示词', [
    context('edit_production_shot', {
      action: 'create',
      nodeId,
      label: 'S01',
      durationMs: 3000,
      firstFramePrompt: '黑暗门厅，右手搭在金属门把上。',
      audio: '门外三次敲击',
    }),
  ]);
  const shotId = project.productionShots![0].id;
  expect(project.scenes[0].storyboardPages).toEqual(originalPages);
  await run(
    '生成首帧，绑定到制作镜头卡',
    [context('generate_shot_image', { shotId, frame: 'first' })],
    { kind: 'execute', externalActions: ['image'] },
  );
  expect(generated).toHaveBeenCalledOnce();
  expect(project.productionShots![0].firstFrameAssetId).toBe('banked-frame');
  expect(project.scenes[0].timeline).toBeUndefined();
  await run('把首帧加入图片轨', [
    context('edit_timeline', {
      nodeId,
      command: { action: 'append_shot_frame', shotId, frame: 'first' },
    }),
  ]);
  const before = structuredClone(project);
  expect(before.scenes[0].timeline?.stillClips).toMatchObject([
    { assetId: 'banked-frame', durationMs: 3000 },
  ]);
  await run('只精简玩家剧情文字', [
    context('edit_scene', {
      action: 'update',
      nodeId,
      patch: { storyboardPages: [{ text: '我认得这三声。', durationMs: 5000 }] },
    }),
  ]);
  expect(project.scenes[0].storyboardPages?.[0].text).toBe('我认得这三声。');
  expect(project.scenes[0].notes).toBe(notes);
  expect(project.scenes[0].timeline).toEqual(before.scenes[0].timeline);
  expect(project.storyDesign).toEqual(before.storyDesign);
  expect(project.productionShots).toEqual(before.productionShots);
});
