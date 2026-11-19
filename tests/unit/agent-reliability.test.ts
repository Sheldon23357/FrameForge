import { expect, it, vi } from 'vitest';
import type { HarnessOptions } from '../../packages/agent/harness';
import { runAgent, runHarness } from '../fixtures/agent-intent';
import { createEditorTools } from '../../packages/agent/tools';
import { newSession, sessionSchema, type ModelFrame } from '../../packages/agent/types';
import { choose, finish, start } from '../../packages/runtime/engine';
import { testProject } from '../fixtures/project';
import { screenplayNeedsReview, updateScreenplay } from '../../packages/domain/screenplay';
import { taskWriteError } from '../../packages/agent/host-task';
import type { HostTaskStep } from '../../packages/agent/task-state';

function call(name: string, args: unknown, id: string = crypto.randomUUID()): ModelFrame {
  return {
    text: '',
    calls: [{ name, arguments: JSON.stringify(args), id }],
    raw: {},
    finish: 'complete',
  };
}
const done: ModelFrame = { text: '全部完成', calls: [], raw: {}, finish: 'complete' };

it('allows production to retime existing visuals and choices within the selected scope', () => {
  const project = testProject();
  const opening = project.scenes[0];
  const other = project.scenes[2];
  for (const node of [opening, other])
    node.timeline = {
      stillClips: [{ id: 'still_existing', assetId: 'asset_frame', durationMs: 9000 }],
      videoClips: [],
      audioClips: [],
    };
  const step = {
    kind: 'blueprint',
    production: true,
    nodeIds: [opening.id],
    initialNodeIds: [opening.id],
    changedNodeIds: [],
    writes: 0,
    done: false,
    build: false,
  } satisfies HostTaskStep;
  const timing = (nodeId: string, patch: object) =>
    taskWriteError(step, project, 'edit_timeline', {
      nodeId,
      command: { action: 'update_still', clipId: 'still_existing', patch },
    });
  const choiceTime = (nodeId: string) =>
    taskWriteError(step, project, 'edit_scene', {
      action: 'update',
      nodeId,
      patch: { choicesAtMs: 10000 },
    });
  expect(timing(opening.id, { durationMs: 12000 })).toBeUndefined();
  expect(choiceTime(opening.id)).toBeUndefined();
  expect(timing(opening.id, { durationMs: 12000, assetId: 'asset_other' })).toBeDefined();
  expect(timing(other.id, { durationMs: 12000 })).toBeDefined();
  expect(choiceTime(other.id)).toBeDefined();
});

function setup(frames: ModelFrame[]) {
  const project = testProject();
  const commit = vi.fn<HarnessOptions['commit']>(() => true);
  const options: Parameters<typeof runHarness>[0] = {
    project,
    commit,
    session: newSession(project.id),
    user: '修改当前节点标题',
    plan: { kind: 'execute' as const },
    provider: 'deepseek',
    model: 'test',
    selectedIds: ['scene_intro'],
    activeChapterId: null,
    registry: createEditorTools(),
    signal: new AbortController().signal,
    runId: 'audit',
    onEvent() {},
    client: async () => {
      const frame = frames.shift();
      if (!frame) throw new Error('测试中断');
      return frame;
    },
  };
  return { options, commit };
}

it('runs blueprint, independent screenplay, then source-verified shots for every targeted node', async () => {
  const { options, commit } = setup([]);
  const [first, second] = ['scene_intro', 'scene_reward'];
  const notes =
    '从哪来｜从作品开场进林。\n已知与持有｜手里有一封信。\n这一段新增什么｜听见响声。\n往哪去｜按选项进树林或沿小路前行。';
  const blocks = [
    { kind: 'action' as const, text: '主角捏着信，停在林边。' },
    { kind: 'sound' as const, text: '背后有树枝折断声。' },
    { kind: 'dialogue' as const, speaker: '主角', text: '有人吗？' },
    { kind: 'monologue' as const, speaker: '主角', text: '那个声音离我越来越近。' },
  ];
  const body = (nodeId: string) => call('edit_screenplay', { nodeId, blocks });
  const read = (nodeId: string, offset = 0, limit = 12) =>
    call('read_screenplay', { action: 'node', nodeId, offset, limit });
  const shot = (nodeId: string) =>
    call('edit_production_shot', {
      nodeId,
      action: 'create',
      label: 'S01',
      durationMs: 2100,
      shotAction: '主角捏着信，回头。',
    });
  const text = (nodeId: string) =>
    call('edit_scene', {
      action: 'update',
      nodeId,
      patch: { storyboardPages: [{ text: '那个声音离我越来越近。' }] },
    });
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockResolvedValueOnce(
      call('edit_scene', { action: 'update', nodeId: first, patch: { notes } }),
    )
    .mockResolvedValueOnce(done)
    .mockImplementationOnce(async ({ tools }) => {
      expect(tools.some(({ name }) => name === 'edit_production_shot')).toBe(false);
      return body(first);
    })
    .mockResolvedValueOnce(body(second))
    .mockResolvedValueOnce(read(first, 0, 1))
    .mockResolvedValueOnce(shot(first))
    .mockImplementationOnce(async ({ exchanges }) => {
      expect(exchanges.at(-1)!.replies[0].result.summary).toContain('读完整节点');
      return read(first, 1);
    })
    .mockResolvedValueOnce(shot(first))
    .mockResolvedValueOnce(text(first))
    .mockResolvedValueOnce(done)
    .mockResolvedValueOnce(
      call('read_batch', {
        requests: [
          { tool: 'read_screenplay', args: { action: 'node', nodeId: second } },
          {
            tool: 'read_story',
            args: { action: 'shots', chapterId: options.project.chapters[0].id },
          },
        ],
      }),
    )
    .mockResolvedValueOnce(shot(second))
    .mockResolvedValueOnce(text(second))
    .mockResolvedValueOnce(done);
  const { turn } = await runHarness({
    ...options,
    selectedIds: [first, second],
    client,
    user: '补全选中的蓝图，写节点剧本正文，再从正文拆镜和编排玩家文字',
    plan: {
      kind: 'execute',
      blueprint: { scope: 'selected', build: true },
      screenplay: { scope: 'selected' },
      production: { scope: 'selected', fromScreenplay: true },
    },
  });
  expect(turn.status, turn.error).toBe('completed');
  expect(turn.hostTask?.steps).toMatchObject([
    { kind: 'blueprint', done: true },
    { kind: 'screenplay', done: true },
    { kind: 'blueprint', fromScreenplay: true, done: true },
  ]);
  const saved = commit.mock.calls.at(-1)![1];
  expect(saved.scenes[0].notes).toBe(notes);
  expect(saved.scenes[0].choices).toEqual(options.project.scenes[0].choices);
  for (const entry of saved.screenplays ?? []) {
    expect(entry.blocks).toEqual(blocks);
    expect(screenplayNeedsReview(saved, entry.id, entry.version)).toBe(false);
  }
  expect(saved.productionShots?.map(({ nodeId }) => nodeId)).toEqual([first, second]);
  const updated = updateScreenplay(saved, first, [
    { kind: 'dialogue', speaker: '主角', text: '谁在那里？' },
  ]);
  expect(screenplayNeedsReview(saved, first, updated.version)).toBe(true);
  expect(screenplayNeedsReview(saved, second, saved.screenplays![1].version)).toBe(false);
});

it('uses the explicitly identified chapter for script writes when the canvas is on another chapter', async () => {
  const { options, commit } = setup([]);
  const current = options.project.chapters[0];
  const target = options.project.scenes.find(({ id }) => id === 'scene_reward')!;
  const targetChapter = {
    id: 'chapter_target',
    title: '第二章《绣中藏锋》',
    startNodeId: target.id,
  };
  options.project.chapters.push(targetChapter);
  target.chapterId = targetChapter.id;
  const blocks = [{ kind: 'action', text: '她抬起书卷，借灯细看。' }];
  const { turn } = await runHarness({
    ...options,
    user: '请审订并保存第二章《绣中藏锋》（chapter_target）全部演出剧本。',
    activeChapterId: current.id,
    plan: { kind: 'execute', screenplay: { scope: 'active' } },
    client: vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce(call('edit_screenplay', { nodeId: target.id, blocks })),
  });
  expect(turn.status, turn.error).toBe('completed');
  expect(turn.requestPlan?.screenplay?.ordinal).toBe(2);
  expect(commit.mock.lastCall?.[1].screenplays).toMatchObject([{ id: target.id, blocks }]);
});

it('requires the entire current screenplay when a batch returns pages out of order', async () => {
  const { options, commit } = setup([]);
  const nodeId = 'scene_intro';
  const entry = updateScreenplay(
    options.project,
    nodeId,
    ['拆开信封。', '展开信纸。', '辨认落款。', '把信收回。'].map((text) => ({
      kind: 'action',
      text,
    })),
  );
  const page = (offset: number, limit: number) => ({ action: 'node', nodeId, offset, limit });
  const createShot = () =>
    call('edit_production_shot', {
      action: 'create',
      nodeId,
      label: 'S01',
      durationMs: 2400,
      shotAction: '主角在林中拆开信封。',
    });
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockResolvedValueOnce(
      call('read_batch', {
        requests: [page(2, 2), page(0, 1), page(4, 1)].map((args) => ({
          tool: 'read_screenplay',
          args,
        })),
      }),
    )
    .mockResolvedValueOnce(createShot())
    .mockImplementationOnce(async ({ exchanges }) => {
      expect(exchanges.at(-1)?.replies[0].result).toMatchObject({
        ok: false,
        summary: expect.stringContaining('offset=1'),
      });
      return call('read_screenplay', page(1, 1));
    })
    .mockResolvedValueOnce(createShot())
    .mockResolvedValueOnce(
      call('edit_scene', {
        action: 'update',
        nodeId,
        patch: { storyboardPages: [{ text: '我把信收回。' }] },
      }),
    )
    .mockResolvedValueOnce(done);
  const { turn } = await runHarness({
    ...options,
    user: '为选中节点从剧本拆分镜并编排玩家文字',
    plan: { kind: 'execute', production: { scope: 'selected', fromScreenplay: true } },
    selectedIds: [nodeId],
    client,
  });
  expect(turn.status, turn.error).toBe('completed');
  const saved = commit.mock.calls.at(-1)![1];
  expect(saved.productionShots).toMatchObject([{ nodeId, screenplayVersion: entry.version }]);
  expect(saved.scenes.find(({ id }) => id === nodeId)?.storyboardScreenplayVersion).toBe(
    entry.version,
  );
});

it('names every stale shot that still prevents screenplay production from completing', async () => {
  const { options, commit } = setup([]);
  const nodeId = 'scene_intro';
  const obsolete = updateScreenplay(options.project, nodeId, [
    { kind: 'action', text: '主角放下信。' },
  ]);
  options.project.productionShots = ['S01', 'S02'].map((label) => ({
    id: `shot_${label}`,
    nodeId,
    label,
    durationMs: 3000,
    screenplayVersion: obsolete.version,
  }));
  const current = updateScreenplay(options.project, nodeId, [
    { kind: 'action', text: '主角展开信纸，随后辨认落款。' },
  ]);
  const revise = (shotId: string, action: string) =>
    call('edit_production_shot', { action: 'update', shotId, patch: { action } });
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockResolvedValueOnce(call('read_screenplay', { action: 'node', nodeId }))
    .mockResolvedValueOnce(revise('shot_S01', '主角展开信纸。'))
    .mockResolvedValueOnce(
      call('edit_scene', {
        action: 'update',
        nodeId,
        patch: { storyboardPages: [{ text: '这个落款，我认得。' }] },
      }),
    )
    .mockResolvedValueOnce(done)
    .mockImplementationOnce(async ({ exchanges }) => {
      expect(exchanges.at(-1)?.feedback).toContain('S02(shot_S02)');
      expect(exchanges.at(-1)?.feedback).not.toContain('S01(shot_S01)');
      return revise('shot_S02', '主角辨认落款。');
    })
    .mockResolvedValueOnce(done);
  const { turn } = await runHarness({
    ...options,
    user: '按当前剧本修订选中节点的全部分镜和玩家文字',
    plan: { kind: 'execute', production: { scope: 'selected', fromScreenplay: true } },
    selectedIds: [nodeId],
    client,
  });
  expect(turn.status, turn.error).toBe('completed');
  expect(commit).toHaveBeenCalledTimes(1);
  expect(
    commit.mock.lastCall?.[1].productionShots?.map(({ screenplayVersion }) => screenplayVersion),
  ).toEqual([current.version, current.version]);
});

it('applies the chosen chapter count, carries creative context, and loads explicitly selected skills', async () => {
  const { options, commit } = setup([]);
  options.project.settings.creativeDefaults = {
    genre: '都市情感',
    tone: '克制冷峻',
    chapterCount: 5,
  };
  const name = 'frameforge-script-review';
  const identity = { name, digest: 'a'.repeat(64) };
  const creativeInput = {
    options: { genre: '悬疑推理', chapterCount: 3, aspectRatio: '9:16' as const },
    skills: [name],
  };
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockImplementationOnce(async ({ system, messages, tools }) => {
      expect(system).toContain('验收用已安装的剧本诊断说明');
      expect(messages.at(-1)?.content).toContain('"genre":"悬疑推理"');
      expect(messages.at(-1)?.content).toContain('"tone":"克制冷峻"');
      expect(tools.some(({ name }) => name === 'update_project')).toBe(false);
      return call('edit_story_design', {
        target: { stage: 'outline' },
        text: '## 第 1 集 开场\n## 第 2 集 转折',
      });
    })
    .mockImplementationOnce(async ({ exchanges }) => {
      expect(exchanges.at(-1)?.replies[0].result.summary).toContain('依次标出 3 章或集');
      return call('edit_story_design', {
        target: { stage: 'outline' },
        text: '## 第 1 集 开场\n## 第 2 集 转折\n## 第 3 集 结尾',
      });
    });
  const { turn } = await runHarness({
    ...options,
    user: '生成全剧大纲',
    creativeInput,
    client,
    plan: { kind: 'execute', design: { outline: true } },
    skills: {
      catalog: [{ ...identity, description: '审核连续性' }],
      read: async () => ({
        text: '验收用已安装的剧本诊断说明',
        file: 'SKILL.md',
        total: 16,
        nextOffset: null,
        truncated: false,
        identity,
      }),
    },
  });
  expect(turn.status, turn.error).toBe('completed');
  expect(turn.requestPlan?.design?.outlineChapterCount).toBe(3);
  expect(turn.creativeInput).toEqual(creativeInput);
  expect(turn.skills).toContainEqual(identity);
  expect(commit.mock.calls[0][1].settings).toEqual(options.project.settings);
});

it('loads the setup skill and patches project parameters alongside the project brief', async () => {
  const { options, commit } = setup([]);
  options.project.settings.creativeDefaults = { viewpoint: '跟随主角', audience: '泛人群' };
  const identity = { name: 'frameforge-project-setup', digest: 'b'.repeat(64) };
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockImplementationOnce(async ({ system, tools }) => {
      expect(system).toContain('立项时主动补齐项目参数');
      expect(tools.some(({ name }) => name === 'update_project')).toBe(true);
      return call('update_project', {
        width: 1080,
        height: 1920,
        atmosphereTone: '低饱和冷灰，保留自然肤色。',
        creativeDefaults: { genre: '都市悬疑', tone: '压迫感', visualStyle: '国产都市写实' },
      });
    })
    .mockResolvedValueOnce(
      call('edit_story_design', {
        target: { stage: 'brief' },
        text: '玩家调查都市旧案，竖屏呈现。',
      }),
    )
    .mockResolvedValueOnce(done);
  const { turn } = await runHarness({
    ...options,
    user: '立项并写入项目简报，按都市悬疑、真人写实和竖屏的规格制作。',
    plan: { kind: 'execute', design: { brief: true, canEditSettings: true } },
    client,
    skills: {
      catalog: [{ ...identity, description: '维护项目参数' }],
      read: async () => ({
        text: '立项时主动补齐项目参数',
        identity,
        total: 11,
        nextOffset: null,
        truncated: false,
      }),
    },
  });
  expect(turn.status, turn.error).toBe('completed');
  expect(turn.creativeInput).toBeUndefined();
  const saved = commit.mock.calls[0][1];
  expect(saved.settings).toMatchObject({
    width: 1080,
    height: 1920,
    atmosphereTone: '低饱和冷灰，保留自然肤色。',
    creativeDefaults: {
      viewpoint: '跟随主角',
      audience: '泛人群',
      genre: '都市悬疑',
      tone: '压迫感',
      visualStyle: '国产都市写实',
    },
  });
  expect(saved.storyDesign?.brief?.text).toContain('竖屏呈现');
});

it('uses the project chapter count when first saving a new outline', async () => {
  const { options } = setup([]);
  options.project.settings.creativeDefaults = { chapterCount: 2 };
  const { turn } = await runHarness({
    ...options,
    user: '生成全剧大纲',
    plan: { kind: 'execute', design: { outline: true } },
    client: async () =>
      call('edit_story_design', {
        target: { stage: 'outline' },
        text: '## 第 1 章 开场\n## 第 2 章 收束',
      }),
  });
  expect(turn.status, turn.error).toBe('completed');
  expect(turn.requestPlan?.design?.outlineChapterCount).toBe(2);
});
it('asks for the user’s story idea on a genre-only request and leaves the project untouched', async () => {
  const { options, commit } = setup([]);
  const reply = '你脑子里最先出现的是哪个人，或哪一幕？可以从一个画面讲起。';
  const client = vi.fn<HarnessOptions['client']>(async (request) => {
    if (request.purpose === 'request_plan') {
      expect(request.system).toContain('我想创建一个奥本海默题材的悬疑故事');
      return { ...done, text: '{"kind":"read","skills":["frameforge-project-setup"]}' };
    }
    expect(request.tools.some((tool) => tool.name === 'edit_story_design')).toBe(false);
    expect(request.tools.some((tool) => tool.name === 'edit_screenplay')).toBe(false);
    expect(request.messages.at(-1)?.content).toContain('一千零一夜');
    expect(request.system).toContain('邀请用户用自己的话描述想写的内容');
    expect(request.system).toContain('问完等用户回答');
    expect(request.system).not.toContain('两个实质不同的故事/玩法方向');
    return { ...done, text: reply };
  });
  const result = await runHarness({
    ...options,
    user: '我想做一个一千零一夜题材的黑暗童话的故事',
    plan: undefined,
    client,
  });
  expect(client).toHaveBeenCalledTimes(2);
  expect(result.turn.hostTask).toBeUndefined();
  expect(result.turn.assistant).toBe(reply);
  expect(result.session.checkpoint).toBeUndefined();
  expect(commit).not.toHaveBeenCalled();
});

it.each([
  { action: 'resume' },
  {
    action: 'start',
    policy: { mode: 'chapter', target: { stage: 'chapter', chapterId: 'missing' } },
  },
])(
  'blocks a write in the same response when its explicitly supplied scope is invalid',
  async (intent) => {
    const { options, commit } = setup([]);
    const write = call('edit_scene', {
      action: 'update',
      nodeId: 'scene_intro',
      patch: { title: '非法修改' },
    });
    const initial = intent
      ? { ...write, calls: [...call('set_task_scope', intent).calls, ...write.calls] }
      : write;
    const client = vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(done);
    const result = await runHarness({ ...options, client });
    expect(result.turn.status).toBe('error');
    expect(result.turn.traces[0].result?.ok).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  },
);

it('executes scope and edit in one response before asking the model for its final reply', async () => {
  const { options, commit } = setup([]);
  const scope = call('set_task_scope', {
    action: 'start',
    policy: { mode: 'execute', target: { stage: 'outline' } },
  });
  const write = call('edit_scene', {
    action: 'update',
    nodeId: 'scene_intro',
    patch: { title: '新标题' },
  });
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockResolvedValueOnce({ ...scope, calls: [...scope.calls, ...write.calls] })
    .mockImplementationOnce(async (request) => {
      expect(request.exchanges[0].replies.map((reply) => reply.result.ok)).toEqual([true, true]);
      return done;
    });
  const result = await runHarness({ ...options, client });
  expect(result.turn.committed).toBe(true);
  expect(client).toHaveBeenCalledTimes(2);
  expect(commit.mock.calls[0][1].scenes[0].title).toBe('新标题');
});

it('executes A -> B -> A as three distinct operations', async () => {
  const { options, commit } = setup([
    ...['甲', '乙', '甲'].map((title) =>
      call('edit_scene', { action: 'update', nodeId: 'scene_intro', patch: { title } }),
    ),
    done,
  ]);
  const result = await runAgent(options);
  expect(result.turn.outcome).toBe('completed');
  expect(commit.mock.calls[0][1].scenes[0].title).toBe('甲');
  expect(result.turn.editCount).toBe(3);
});

it('does not deduplicate two intentional creations with identical content', async () => {
  const create = () =>
    call('edit_scene', {
      action: 'create',
      kind: 'video',
      title: '重复场景',
      notes: '主角回到现场，记起此前发生的同一事件。',
      storyboardPages: [{ text: '同一事件再次发生。' }],
    });
  const { options, commit } = setup([create(), create(), done]);
  const result = await runAgent(options);
  expect(commit.mock.calls[0][1].scenes.filter((row) => row.title === '重复场景')).toHaveLength(2);
  expect(result.turn.outcome, result.turn.error).toBe('completed');
});

it('rejects reuse of one call identity with different arguments', async () => {
  const edit = (title: string) =>
    call('edit_scene', { action: 'update', nodeId: 'scene_intro', patch: { title } }, 'same');
  const { options, commit } = setup([edit('甲'), edit('乙'), done]);
  const result = await runAgent(options);
  expect(result.turn.traces[1].result?.ok).toBe(false);
  expect(commit.mock.calls[0][1].scenes[0].title).toBe('甲');
});

it('executes both settings and node edits without permitting unrelated settings', async () => {
  const { options, commit } = setup([
    call('update_project', { title: '测试', author: '未要求的作者' }),
    call('update_project', { title: '测试' }),
    call('edit_scene', {
      action: 'update',
      nodeId: 'scene_intro',
      patch: { title: '新节点标题' },
    }),
    done,
  ]);
  const result = await runAgent({
    ...options,
    user: '修改作品标题为测试，并修改节点标题',
    intent: {
      action: 'start',
      policy: { mode: 'execute', target: { stage: 'outline' }, fields: ['title'] },
    },
  });
  expect(result.turn.traces[0].result?.ok).toBe(false);
  expect(commit.mock.calls[0][1]).toMatchObject({
    title: '测试',
    settings: { author: options.project.settings.author },
  });
  expect(commit.mock.calls[0][1].scenes[0].title).toBe('新节点标题');
});

it.each([false, true])(
  'reconnects a generated asset after cancellation (legacy: %s)',
  async (legacy) => {
    const { options, commit } = setup([]);
    options.project.worldSettings = [
      { id: 'actor', kind: 'character', name: '角色', visual: '深蓝外套，短发，灰色眼睛。' },
    ];
    const signal = new AbortController();
    const asset = {
      id: 'asset_test',
      name: '参考图',
      path: 'assets/test.png',
      type: 'image' as const,
      size: 100,
      width: 300,
      height: 200,
      durationMs: 0,
      builtin: false,
    };
    const generate = vi.fn(async () => {
      signal.abort();
      return asset;
    });
    const media = { generateReference: generate };
    const frame = () => call('generate_world_reference', { settingId: 'actor', kind: 'image' });
    const first = await runAgent({
      ...options,
      media,
      signal: signal.signal,
      user: '生成角色参考图',
      plan: { kind: 'execute', externalActions: ['image'] },
      client: async () => frame(),
    });
    expect(first.turn.status).toBe('stopped');
    expect(first.session.checkpoint?.mediaJobs?.[0].assets?.[0].id).toBe(asset.id);
    const restoredSession = sessionSchema.parse(first.session);
    if (legacy) delete restoredSession.checkpoint?.requestPlan?.externalActions;
    const frames = legacy
      ? [
          call('generate_world_reference', {
            settingId: 'actor',
            kind: 'image',
            imageAspect: '1:1',
          }),
          frame(),
          done,
        ]
      : [frame(), done];
    const second = await runAgent({
      ...options,
      media,
      session: restoredSession,
      user: '继续',
      useRealPlan: true,
      intent: { action: 'resume' },
      client: async ({ purpose }) => {
        expect(purpose).toBeUndefined();
        return frames.shift()!;
      },
    });
    expect(second.turn.outcome, second.turn.error).toBe('completed');
    if (legacy) expect(second.turn.traces[0].result?.summary).toContain('只能接回已发起');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][1].worldSettings?.[0].imageAssetId).toBe(asset.id);
  },
);

it('preserves a suspended draft when the user asks to discuss before continuing', async () => {
  const { options, commit } = setup([
    call('edit_scene', { action: 'update', nodeId: 'scene_intro', patch: { title: '草稿标题' } }),
  ]);
  const first = await runAgent(options);
  const second = await runAgent({
    ...options,
    session: first.session,
    user: '继续，但先讨论，不要改工程',
    plan: { kind: 'read' },
    intent: { action: 'start', policy: { mode: 'discuss', target: { stage: 'outline' } } },
    client: async (request) => {
      expect(request.tools.some((tool) => tool.name === 'edit_scene')).toBe(false);
      return done;
    },
  });
  expect(second.session.checkpoint?.draft.scenes[0].title).toBe('草稿标题');
  expect(commit).not.toHaveBeenCalled();
});

it('requires the declared project settings before saving the new outline', async () => {
  const target = { stage: 'outline' } as const;
  const write = () => call('edit_story_design', { target, text: '新大纲' });
  const { options, commit } = setup([
    write(),
    call('update_project', { title: '第七夜血书' }),
    write(),
    done,
  ]);
  const result = await runAgent({
    ...options,
    intent: {
      action: 'start',
      policy: { mode: 'design', target, fields: ['title'], designTargets: [target] },
    },
  });
  expect(result.turn.traces[0].result?.summary).toContain('先完成');
  expect(commit.mock.calls[0][1]).toMatchObject({
    title: '第七夜血书',
    storyDesign: { outline: { text: '新大纲' } },
  });
});

it('resumes a legacy chapter draft with contradictory checks and unfinished stages', async () => {
  const { options, commit } = setup([]);
  const target = { stage: 'chapter', chapterId: options.project.chapters[0].id } as const;
  const interrupted = await runHarness({
    ...options,
    maxRounds: 1,
    client: async () => call('edit_story_design', { target, text: '旧草稿正文' }),
  });
  const checkpoint = interrupted.session.checkpoint!;
  const checks = [
    { kind: 'design', target, status: 'draft' },
    { kind: 'design', target, status: 'confirmed' },
  ] as const;
  checkpoint.stages = [
    { title: '旧计划', goal: '保存正文', acceptance: '同时草稿和确认', checks: [...checks] },
  ];
  const frames = [call('set_task_scope', { action: 'resume' }), done];
  const client = vi.fn<HarnessOptions['client']>(async ({ tools }) => {
    expect(
      tools.filter(({ name }) =>
        ['plan_task', 'complete_task_stage', 'update_task_state'].includes(name),
      ),
    ).toEqual([]);
    return frames.shift()!;
  });
  const resumed = await runHarness({
    ...options,
    session: sessionSchema.parse(interrupted.session),
    user: '继续',
    plan: { kind: 'resume' },
    client,
  });
  expect(resumed.turn.committed, resumed.turn.error).toBe(true);
  expect(client).toHaveBeenCalledTimes(2);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0][1].storyDesign?.chapters[0].text).toBe('旧草稿正文');
  expect(resumed.session.checkpoint).toBeUndefined();
});

it('allows the two supported aspect ratios and leaves legacy sizes intact until changed', () => {
  const { options } = setup([]);
  const context = { project: options.project, selectedIds: [], activeChapterId: null, intents: [] };
  context.project.settings.width = 1440;
  context.project.settings.height = 1080;
  const update = (args: object) =>
    options.registry.execute('update_project', JSON.stringify(args), context);
  expect(update({ title: '旧工程' }).ok).toBe(true);
  expect(context.project.settings.width).toBe(1440);
  expect(update({ width: 1080, height: 1080 }).ok).toBe(false);
  expect(context.project.settings.width).toBe(1440);
  expect(update({ width: 1080, height: 1920 }).ok).toBe(true);
  expect(update({ width: 1920, height: 1080 }).ok).toBe(true);
});

it.each([5, 6])(
  'uses a table outline as source and saves the chapters actually written (%i of 6)',
  async (count) => {
    const target = { stage: 'outline' } as const;
    const { options, commit } = setup([]);
    const outline = '## 章节地图\n\n| 第一章 | 开场 |\n| 第二章 | 分歧 |';
    const project = options.project;
    const context = { project, selectedIds: [], activeChapterId: null, intents: [] };
    expect(
      options.registry.execute(
        'edit_story_design',
        JSON.stringify({ target, text: outline }),
        context,
      ).ok,
    ).toBe(true);
    options.project = context.project;
    let round = 0;
    const client: HarnessOptions['client'] = async (request) => {
      if (round++ === 0)
        return call('set_task_scope', {
          action: 'start',
          policy: { mode: 'design', target, saveChapterStructure: true, chapterCount: 6 },
        });
      if (round === 2) {
        expect(request.messages.at(-1)?.content).toContain('没有可原样复制的完整分章正文');
        expect(request.tools.some((tool) => tool.name === 'edit_chapter')).toBe(true);
        expect(request.tools.some((tool) => tool.name === 'edit_scene')).toBe(false);
        const calls = Array.from(
          { length: count },
          (_, i) => call('edit_chapter', { action: 'create', title: `章节 ${i + 1}` }).calls[0],
        );
        return { ...done, text: '', calls };
      }
      if (round === 3) {
        const chapters = request.exchanges
          .at(-1)!
          .replies.map((reply) => reply.result.data as { id: string });
        const calls = chapters.map(
          ({ id }) =>
            call('edit_story_design', {
              target: { stage: 'chapter', chapterId: id },
              text: `独立正文 ${id}`,
            }).calls[0],
        );
        return { ...done, text: '', calls };
      }
      return done;
    };
    const result = await runHarness({ ...options, client });
    expect(result.turn.committed, result.turn.error).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][1].storyDesign?.chapters).toHaveLength(count);
    expect(commit.mock.calls[0][1].storyDesign?.outline?.text).toBe(outline);
    expect(round).toBe(4);
  },
);

it('executes ordinary project edits directly without a scope call', async () => {
  const { options, commit } = setup([
    call('update_project', { title: '新标题' }),
    call('edit_story_design', { target: { stage: 'outline' }, text: '大纲正文' }),
    done,
  ]);
  const result = await runHarness(options);
  expect(result.turn.committed).toBe(true);
  expect(result.turn.execution?.modelRequests).toBe(3);
  expect(commit.mock.calls[0][1]).toMatchObject({
    title: '新标题',
    storyDesign: { outline: { text: '大纲正文' } },
  });
});

it('uses a short confirmation for only the offered chapter and blocks blueprint and draft confirmation calls', async () => {
  const { options, commit } = setup([]);
  const first = options.project.chapters[0];
  options.session.turns.push({
    id: 'previous',
    user: '从第一章开始重写，注意 12 章对应大纲中的四章',
    assistant: '第一章已写入。全剧计划 12 章。\n要我继续写**第2章**吗？',
    status: 'completed',
    createdAt: new Date().toISOString(),
    provider: 'deepseek',
    model: 'test',
    traces: [],
    committed: true,
    changedNodeIds: [],
  });
  const outline = { stage: 'outline' };
  const scope = call('set_task_scope', {
    action: 'start',
    policy: { mode: 'design', target: outline, chapterDesign: true },
  });
  const chapter = call('edit_chapter', {
    action: 'create',
    title: '第二章',
    designText: '我听见门后的脚步。\n我：谁在那儿？',
  });
  const scene = call('edit_scene', {
    action: 'update',
    nodeId: 'scene_intro',
    patch: { title: '越界蓝图修改' },
  });
  const otherChapter = call('edit_chapter', {
    action: 'update',
    chapterId: first.id,
    patch: {},
    designText: '越界正文',
  });
  const thirdChapter = call('edit_chapter', {
    action: 'create',
    title: '第三章',
    designText: '越界续写',
  });
  const client = vi.fn<HarnessOptions['client']>().mockImplementationOnce(async ({ tools }) => {
    expect(tools.some(({ name }) => name === 'edit_scene')).toBe(false);
    return {
      ...chapter,
      calls: [
        ...scope.calls,
        ...chapter.calls,
        ...scene.calls,
        ...otherChapter.calls,
        ...thirdChapter.calls,
      ],
    };
  });
  const { turn } = await runHarness({
    ...options,
    user: '是的',
    plan: {
      kind: 'execute',
      design: { chapter: true, chapters: { kind: 'ordinals', values: [2] } },
    },
    client,
  });
  expect(turn.status, turn.error).toBe('completed');
  expect(client).toHaveBeenCalledTimes(1);
  expect(turn.traces.map(({ status }) => status)).toEqual(['done', 'error', 'error', 'error']);
  expect(turn.assistant).toContain('已保存第 2 章正文草稿');
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0][1].storyDesign?.chapters).toMatchObject([
    { text: '我听见门后的脚步。\n我：谁在那儿？', confirmed: false },
  ]);
  expect(commit.mock.calls[0][1].scenes).toEqual(options.project.scenes);
});

it('builds an explicitly requested blueprint and finishes after the host sees a connected playable path', async () => {
  const { options, commit } = setup([]);
  const chapterId = options.project.chapters[0].id;
  const source = options.project.scenes.find(({ id }) => id === 'scene_reward')!;
  const originalTarget = source.nextId;
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockImplementationOnce(async ({ tools }) => {
      expect(tools.some(({ name }) => name === 'edit_scene')).toBe(true);
      expect(tools.some(({ name }) => name === 'edit_story_design')).toBe(false);
      return call('edit_scene', {
        action: 'create',
        kind: 'video',
        chapterId,
        title: '夜路过场',
        notes: '主角沿夜路前进，在岔路灯下停住。',
        storyboardPages: [{ text: '我沿小路走过去。', durationMs: 3000 }],
      });
    })
    .mockResolvedValueOnce(done)
    .mockImplementationOnce(async ({ exchanges }) => {
      const created = exchanges[0].replies[0].result.data as { nodeId: string };
      const links = call('edit_scene', {
        action: 'batch',
        operations: [
          { action: 'connect', fromId: source.id, toId: created.nodeId },
          { action: 'connect', fromId: created.nodeId, toId: originalTarget },
        ],
      });
      const extra = call('edit_story_design', {
        target: { stage: 'chapter', chapterId },
        text: '额外改作者稿',
      });
      return { ...links, calls: [...links.calls, ...extra.calls] };
    });
  const { turn } = await runHarness({
    ...options,
    user: '搭建第一章蓝图，创建1个剧情节点并接回原路线',
    plan: { kind: 'execute', blueprint: { build: true, ordinal: 1, minimumNewNodes: 1 } },
    client,
  });
  expect(turn.status, turn.error).toBe('completed');
  expect(client).toHaveBeenCalledTimes(3);
  expect(turn.traces.at(-1)?.status).toBe('error');
  const saved = commit.mock.calls[0][1];
  const node = saved.scenes.find(({ title }) => title === '夜路过场');
  expect(node?.nextId).toBe(originalTarget);
  expect(saved.scenes.find(({ id }) => id === source.id)?.nextId).toBe(node?.id);
  expect(saved.storyDesign).toBeUndefined();
});

it.each([false, true])(
  'finishes a chapter with one pending handoff only if the next chapter is empty (built: %s)',
  async (nextChapterBuilt) => {
    const { options, commit } = setup([]);
    const next = { id: 'chapter_next', title: '第二章', startNodeId: '' };
    options.project.chapters.push(next);
    if (nextChapterBuilt) {
      const ending = options.project.scenes.find(({ kind }) => kind === 'ending')!;
      next.startNodeId = 'scene_next';
      options.project.scenes.push({ ...ending, id: next.startNodeId, chapterId: next.id });
    }
    const chapterId = options.project.chapters[0].id;
    const source = options.project.scenes.find(({ id }) => id === 'scene_consume')!;
    let exitId: string;
    const client = vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValue(done)
      .mockResolvedValueOnce(
        call('edit_scene', {
          action: 'create',
          kind: 'video',
          chapterId,
          title: '章尾余波',
          notes: '暗门打开，准备接入下一章。',
          storyboardPages: [{ text: '我走进暗门。' }],
        }),
      )
      .mockImplementationOnce(async ({ exchanges }) => {
        exitId = exchanges.at(-1)!.replies[0].result.nodeIds![0];
        // Keep the original ending reachable through the other branch.
        return call('edit_scene', {
          action: 'connect',
          fromId: source.id,
          toId: exitId,
        });
      });
    const ending = options.project.scenes.find(({ id }) => id === source.nextId)!;
    options.project.scenes.find(({ id }) => id === 'scene_branch')!.choices[1].targetId = ending.id;
    // Preserve the original fallback ending on the clearing route.
    options.project.scenes.find(({ id }) => id === 'scene_alternate')!.choices[1].targetId =
      'scene_neutral';
    const { turn, session } = await runHarness({
      ...options,
      user: '继续搭建第一章的章节蓝图',
      plan: { kind: 'execute', blueprint: { build: true, ordinal: 1 } },
      client,
      liveUpdates: true,
    });
    if (nextChapterBuilt) {
      expect(turn.committed).toBe(false);
      expect(commit).not.toHaveBeenCalled();
      expect(turn.status).toBe('error');
      expect(turn.outcome).toBe('partial');
      expect(turn.remaining).toEqual([expect.stringContaining(`「章尾余波」(${exitId!})`)]);
      expect(session.checkpoint?.draft.scenes.find(({ id }) => id === exitId)).toMatchObject({
        nextId: '',
      });
    } else {
      expect(turn.committed).toBe(true);
      expect(commit.mock.calls.at(-1)?.[1].scenes.find(({ id }) => id === exitId)).toMatchObject({
        nextId: '',
      });
      expect(turn.status, turn.error).toBe('completed');
      expect(turn.assistant).toContain('「章尾余波」的章尾出口待接入「第二章」');
      expect(client).toHaveBeenCalledTimes(3);
      expect(session.checkpoint).toBeUndefined();
    }
  },
);

it('continues a saved multi-chapter host task from its first unfinished document', async () => {
  const { options, commit } = setup([]);
  const first = options.project.chapters[0];
  const initial = vi
    .fn<HarnessOptions['client']>()
    .mockResolvedValueOnce(
      call('edit_chapter', {
        action: 'update',
        chapterId: first.id,
        patch: {},
        designText: '第一章正文。',
      }),
    )
    .mockRejectedValueOnce(new Error('网关暂时不可用'));
  const paused = await runHarness({
    ...options,
    user: '写完两章剧本',
    plan: {
      kind: 'execute',
      design: { chapter: true, chapters: { kind: 'range', from: 1, through: 2 } },
    },
    client: initial,
  });
  const saved = sessionSchema.parse(paused.session);
  expect(paused.turn.status).toBe('error');
  expect(saved.checkpoint?.hostTask?.steps).toMatchObject([
    { ordinal: 1, chapterId: first.id, receipt: expect.any(String) },
    { ordinal: 2 },
  ]);
  const status = await runHarness({
    ...options,
    session: saved,
    user: '现在项目进行到什么阶段了',
    plan: { kind: 'status' },
    client: vi.fn(),
  });
  expect(status.turn.assistant).toContain('已完成 1/2 个步骤');
  expect(status.session.checkpoint?.hostTask?.id).toBe(saved.checkpoint?.hostTask?.id);
  const second = call('edit_chapter', {
    action: 'create',
    title: '第二章',
    designText: '第二章正文。',
  });
  const resume = vi.fn<HarnessOptions['client']>().mockImplementationOnce(async ({ messages }) => {
    expect(messages.at(-1)!.content).toContain('第一章正文。');
    expect(messages.at(-1)!.content).toContain('"ordinal":2');
    return second;
  });
  const result = await runHarness({
    ...options,
    session: status.session,
    user: '继续',
    plan: { kind: 'resume' },
    client: resume,
  });
  expect(result.turn.status, result.turn.error).toBe('completed');
  expect(result.turn.hostTask?.id).toBe(saved.checkpoint?.hostTask?.id);
  expect(resume).toHaveBeenCalledTimes(1);
  expect(result.session.checkpoint).toBeUndefined();
  expect(commit.mock.calls[0][1].storyDesign?.chapters.map(({ text }) => text)).toEqual([
    '第一章正文。',
    '第二章正文。',
  ]);
});

it('allows a script and matching blueprint edit when the user requests both', async () => {
  const { options, commit } = setup([]);
  const chapterId = options.project.chapters[0].id;
  const { turn } = await runHarness({
    ...options,
    user: '写完第一章剧本，并更新蓝图里的节点标题',
    plan: {
      kind: 'execute',
      design: { chapter: true, chapters: { kind: 'ordinals', values: [1] } },
      blueprint: { build: false, ordinal: 1 },
    },
    client: vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce(
        call('edit_chapter', { action: 'update', chapterId, patch: {}, designText: '我推门。' }),
      )
      .mockResolvedValueOnce(
        call('edit_scene', { action: 'update', nodeId: 'scene_intro', patch: { title: '推门' } }),
      )
      .mockResolvedValueOnce(done),
  });
  expect(turn.status, turn.error).toBe('completed');
  expect(commit.mock.calls[0][1].scenes.find(({ id }) => id === 'scene_intro')?.title).toBe(
    '推门',
  );
  expect(commit.mock.calls[0][1].storyDesign?.chapters[0].text).toBe('我推门。');
});

it('reuses newly authored text and a fully covered outline after the exchange window is rebuilt', async () => {
  const { options, commit } = setup([]);
  const chapterId = options.project.chapters[0].id;
  const target = { stage: 'outline' };
  const chapter = { stage: 'chapter', chapterId };
  const outline = '开场故事铺垫。'.repeat(500) + '结局前的真相。'.repeat(500);
  options.project.storyDesign = {
    outline: { text: outline, version: crypto.randomUUID(), confirmed: true },
    chapters: [],
  };
  const designText = '我听见窗外雨声，决定先检查门栓。';
  const first = call('read_story_design', { target, limit: 4000 });
  const second = call('read_story_design', { target, offset: 4000 });
  const written = call('edit_chapter', { action: 'update', chapterId, patch: {}, designText });
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockResolvedValueOnce({ ...first, calls: [...first.calls, ...second.calls] })
    .mockResolvedValueOnce(written)
    .mockResolvedValueOnce({
      ...call('check_story', { action: 'validate' }),
      raw: { largeProviderFrame: 'x'.repeat(200_000) },
    })
    .mockImplementationOnce(async ({ messages }) => {
      const current = messages.at(-1)!.content;
      expect(current).toContain('stillCurrentReads');
      expect(current).toContain(designText);
      const carried = JSON.parse(current.split('\n').at(-1)!).stillCurrentReads as {
        data: { target?: typeof target; offset: number; text: string };
      }[];
      expect(
        carried
          .filter(({ data }) => data.target?.stage === 'outline')
          .map(({ data }) => [data.offset, data.text?.length]),
      ).toEqual([
        [4000, outline.length - 4000],
        [0, 4000],
      ]);
      return call('read_batch', {
        requests: [
          { tool: 'read_story_design', args: { target, limit: 4000 } },
          { tool: 'read_story_design', args: { target, limit: 12000 } },
          { tool: 'read_story_design', args: { target: chapter } },
        ],
      });
    })
    .mockImplementationOnce(async ({ exchanges }) => {
      expect(exchanges.at(-1)?.replies[0].result.data).toMatchObject({
        results: Array.from({ length: 3 }, () => ({ data: { reused: true, nextOffset: null } })),
      });
      return done;
    });
  const { turn } = await runHarness({ ...options, user: '根据大纲完善当前正文与工程备注', client });
  expect(turn.status, turn.error).toBe('completed');
  expect(turn.execution?.contextCompactions).toBeGreaterThan(0);
  expect(commit.mock.calls[0][1].storyDesign?.chapters[0].text).toBe(designText);
});

it('uses the model’s contextual progress intent without offering or executing project tools', async () => {
  const { options, commit } = setup([]);
  options.project.storyDesign = {
    outline: { text: '全剧梗概', confirmed: true, version: crypto.randomUUID() },
    chapters: [],
  };
  const user = '离能交付还有多远？';
  const client = vi.fn<HarnessOptions['client']>(async (request) => {
    expect(request.purpose).toBe('request_plan');
    expect(request.tools).toEqual([]);
    expect(JSON.parse(request.messages[0].content).request).toBe(user);
    return { ...done, text: '{"kind":"status"}' };
  });
  const { turn } = await runHarness({ ...options, user, plan: undefined, client });
  expect(turn.status, turn.error).toBe('completed');
  expect(turn.assistant).toContain('全剧大纲：已确认。章节正文：0/1 章。');
  expect(turn.execution?.modelRequests).toBe(0);
  expect(client).toHaveBeenCalledOnce();
  expect(commit).not.toHaveBeenCalled();
});

it('retries invalid structured intent once and never runs project tools when it remains invalid', async () => {
  const { options, commit } = setup([]);
  const client = vi.fn<HarnessOptions['client']>().mockResolvedValue({ ...done, text: '{}' });
  const { turn } = await runHarness({ ...options, plan: undefined, client });
  expect(turn.status).toBe('error');
  expect(turn.error).toContain('未能返回有效的创作范围');
  expect(client).toHaveBeenCalledTimes(2);
  expect(turn.traces).toHaveLength(0);
  expect(commit).not.toHaveBeenCalled();
});

it('reorders only the outline as a twelve-chapter draft and finishes on the write receipt', async () => {
  const { options, commit } = setup([]);
  options.project.storyDesign = {
    outline: { text: '旧大纲', version: crypto.randomUUID(), confirmed: true },
    chapters: [],
  };
  const target = { stage: 'outline' };
  const text = Array.from({ length: 12 }, (_, index) => `| 第${index + 1}章 | 情节与选择 |`).join(
    '\n',
  );
  const extra = call('edit_scene', {
    action: 'update',
    nodeId: 'scene_intro',
    patch: { title: '越界' },
  });
  const wrongCount = call('edit_story_design', { target, text: '## 第一章 开场\n新的冲突' });
  const wrongOrder = call('edit_story_design', {
    target,
    text: text.split('\n').reverse().join('\n'),
  });
  const draft = call('edit_story_design', { target, text });
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockImplementationOnce(async ({ tools }) => {
      expect(tools.some(({ name }) => name === 'edit_chapter' || name === 'edit_scene')).toBe(
        false,
      );
      return {
        ...done,
        calls: [
          ...call('edit_story_design', { target, text, confirmed: true }).calls,
          ...wrongCount.calls,
          ...wrongOrder.calls,
        ],
        text: '',
      };
    })
    .mockImplementationOnce(async ({ exchanges }) => {
      expect(exchanges.at(-1)!.replies.map(({ result }) => result.ok)).toEqual([
        false,
        false,
        false,
      ]);
      return { ...draft, calls: [...draft.calls, ...extra.calls] };
    });
  const { turn } = await runHarness({
    ...options,
    user: '大纲按12章重排',
    plan: { kind: 'execute', design: { outline: true, outlineChapterCount: 12 } },
    client,
  });
  expect(turn.status, turn.error).toBe('completed');
  expect(turn.assistant).toContain('12 章');
  expect(client).toHaveBeenCalledTimes(2);
  expect(turn.traces.map(({ status }) => status)).toEqual([
    'error',
    'error',
    'error',
    'done',
    'error',
  ]);
  expect(commit.mock.calls[0][1].storyDesign?.outline).toMatchObject({ text, confirmed: false });
  expect(commit.mock.calls[0][1].scenes).toEqual(options.project.scenes);
  expect(commit.mock.calls[0][1].chapters).toEqual(options.project.chapters);
});

it.each([
  [
    'episode rows',
    [
      '| 集数 | 情节 |',
      '| --- | --- |',
      ...[1, 2, 3, 4, 5].map((number) => `| **第 ${number} 集**<br>《场名》 | 情节与选择 |`),
    ].join('\n'),
  ],
  [
    'mixed headings',
    [
      '## 第 1 集：开场',
      '## 第二章：分歧',
      '## 第 3 章：汇流',
      '## 第四集：转折',
      '## 第 5 集：收束',
    ].join('\n'),
  ],
])('saves a five-part outline on the first write with %s', async (_format, text) => {
  const { options, commit } = setup([]);
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockResolvedValueOnce(call('edit_story_design', { target: { stage: 'outline' }, text }));
  const { turn } = await runHarness({
    ...options,
    user: '写一个 5 集大纲并保存',
    plan: { kind: 'execute', design: { outline: true, outlineChapterCount: 5 } },
    client,
  });
  expect(turn.status, turn.error).toBe('completed');
  expect(client).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0][1].storyDesign?.outline).toMatchObject({ text, confirmed: false });
});

it('checkpoints each chapter with its text and resumes after a model gateway timeout', async () => {
  const { options, commit } = setup([]);
  const firstId = options.project.chapters[0].id;
  const saveCheckpoint = vi.fn<NonNullable<HarnessOptions['saveCheckpoint']>>();
  const model = vi
    .fn<HarnessOptions['client']>()
    .mockResolvedValueOnce(
      call('edit_chapter', {
        action: 'update',
        chapterId: firstId,
        patch: { title: '第一章 · 铜灯' },
        designText: '契约师接下委托。',
      }),
    )
    .mockRejectedValueOnce(new Error('模型服务暂时不可用（HTTP 504）。'));
  const interrupted = await runHarness({ ...options, client: model, saveCheckpoint });
  expect(interrupted.turn.error).toContain('504');
  expect(commit).not.toHaveBeenCalled();
  expect(saveCheckpoint.mock.lastCall?.[0].checkpoint?.draft.storyDesign?.chapters).toMatchObject([
    { id: firstId, text: '契约师接下委托。', confirmed: false },
  ]);

  const resumeModel = vi
    .fn<HarnessOptions['client']>()
    .mockImplementationOnce(async (request) => {
      expect(request.messages.at(-1)?.content).toContain(
        JSON.stringify({ id: firstId, title: '第一章 · 铜灯', hasDesign: true }),
      );
      return call('edit_chapter', {
        action: 'create',
        title: '第二章 · 铜镜',
        designText: '契约师在镜中发现真凶。',
      });
    })
    .mockResolvedValueOnce(done);
  const resumed = await runHarness({
    ...options,
    session: sessionSchema.parse(interrupted.session),
    user: '继续',
    plan: { kind: 'resume' },
    client: resumeModel,
  });
  expect(resumed.turn.committed, resumed.turn.error).toBe(true);
  expect(commit).toHaveBeenCalledTimes(1);
  const saved = commit.mock.calls[0][1];
  const second = saved.chapters.find(({ title }) => title === '第二章 · 铜镜');
  expect(second).toBeDefined();
  expect(saved.storyDesign?.chapters).toMatchObject([
    { id: firstId, text: '契约师接下委托。' },
    { id: second?.id, text: '契约师在镜中发现真凶。' },
  ]);
});

it('stops repeated project reads before exhausting the model request budget', async () => {
  const { options } = setup([]);
  const client = vi.fn<HarnessOptions['client']>(async () => call('read_project', {}));
  const result = await runHarness({ ...options, client });
  expect(client).toHaveBeenCalledTimes(4);
  expect(result.turn.error).toContain('连续三轮只重复读取');
});

it.each(['materials', 'legacy blueprint', 'amended materials'] as const)(
  'resumes interrupted %s work from bound first frames and verifies the still track',
  async (mode) => {
    const { options, commit } = setup([]);
    const scene = options.project.scenes[0];
    const nodeId = scene.id;
    delete scene.assetId;
    scene.storyboardPages = [{ text: '树影里传来脚步。', durationMs: 3000 }];
    const shot = (id: string, label: string) => ({
      id,
      label,
      nodeId,
      durationMs: 4500,
      firstFramePrompt: '树林，晨光，石径。',
    });
    const [first, second] = [shot('shot_a', 'S01'), shot('shot_b', 'S02')];
    options.project.productionShots = [first, second];
    const generate = (shotId: string) => call('generate_shot_image', { shotId });
    const append = (shotId: string) =>
      call('edit_timeline', {
        nodeId,
        command: { action: 'append_shot_frame', shotId, frame: 'first' },
      });
    let image = 0;
    const generateShotImage = vi.fn(async () => ({
      id: `still_${++image}`,
      name: '测试.png',
      path: `assets/still_${image}.png`,
      type: 'image' as const,
      size: 123,
      durationMs: 0,
      width: 64,
      height: 64,
      builtin: false,
    }));
    const media = { imageProvider: 'minimax' as const, generateShotImage };
    const interrupted = await runHarness({
      ...options,
      media,
      liveUpdates: true,
      user: '补齐分镜首帧并用 append_shot_frame 按顺序排入图片时间线。',
      plan:
        mode === 'materials'
          ? { kind: 'execute', materials: { scope: 'selected', generate: true, timeline: true } }
          : {
              kind: 'execute',
              blueprint: { scope: 'selected', build: false },
              externalActions: ['image'],
            },
      client: vi
        .fn<HarnessOptions['client']>()
        .mockResolvedValueOnce(generate(first.id))
        .mockRejectedValueOnce(new Error('模拟网关中断')),
    });
    expect(interrupted.turn.status).toBe('error');
    expect(interrupted.turn.committed).toBe(true);
    const project = commit.mock.lastCall![1];
    expect(project.productionShots?.[0].firstFrameAssetId).toBe('still_1');
    const resumed = await runHarness({
      ...options,
      project,
      media,
      session: sessionSchema.parse(interrupted.session),
      liveUpdates: true,
      user: '继续',
      plan:
        mode === 'amended materials'
          ? { kind: 'amend', materials: { scope: 'selected', generate: true, timeline: true } }
          : { kind: 'resume' },
      client: vi
        .fn<HarnessOptions['client']>()
        .mockImplementationOnce(async ({ messages, tools }) => {
          expect(messages.at(-1)?.content).toContain('缺少已绑定首帧的镜头');
          expect(tools.map(({ name }) => name)).not.toContain('edit_choice');
          return generate(second.id);
        })
        .mockResolvedValueOnce(done)
        .mockResolvedValueOnce(append(first.id))
        .mockResolvedValueOnce(append(first.id))
        .mockResolvedValueOnce(append(second.id)),
    });
    expect(resumed.turn.status, resumed.turn.error).toBe('completed');
    expect(resumed.turn.assistant).toContain('2 个镜头的首帧绑定与节点图片轨');
    expect(resumed.session.checkpoint).toBeUndefined();
    expect(generateShotImage).toHaveBeenCalledTimes(2);
    expect(commit.mock.lastCall![1].scenes[0].timeline?.stillClips).toMatchObject([
      { assetId: 'still_1', durationMs: 4500 },
      { assetId: 'still_2', durationMs: 4500 },
    ]);
    expect(commit.mock.lastCall![1].scenes[0].choices).toEqual(scene.choices);
  },
);

it('requires a new first frame and replaces the original still clip across a restart', async () => {
  const { options, commit } = setup([]);
  const scene = options.project.scenes[0];
  delete scene.assetId;
  const oldAsset = {
    id: 'still_old',
    name: '旧分镜.png',
    path: 'assets/old.png',
    type: 'image' as const,
    size: 123,
    durationMs: 0,
    width: 64,
    height: 64,
    builtin: false,
  };
  const original = { id: 'clip_original', assetId: oldAsset.id, durationMs: 9000, dissolveMs: 150 };
  scene.timeline = { stillClips: [original], videoClips: [], audioClips: [] };
  options.project.assets.push(oldAsset);
  const shotId = 'shot_replace';
  options.project.productionShots = [
    {
      id: shotId,
      nodeId: scene.id,
      label: 'S01',
      durationMs: 9000,
      firstFramePrompt: '手按住袖口的铜顶针。',
      firstFrameAssetId: oldAsset.id,
    },
  ];
  const generateShotImage = vi.fn(async () => ({
    ...oldAsset,
    id: 'still_new',
    path: 'assets/new.png',
  }));
  const media = { imageProvider: 'minimax' as const, generateShotImage };
  const interrupted = await runHarness({
    ...options,
    media,
    liveUpdates: true,
    user: '替换已有首帧和原时间线片段。',
    plan: {
      kind: 'execute',
      materials: { scope: 'selected', generate: true, replace: true, timeline: true },
    },
    client: vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce(done)
      .mockImplementationOnce(async ({ messages, exchanges }) => {
        expect([messages.at(-1)?.content, exchanges.at(-1)?.feedback].join()).toContain(
          '仍绑定旧首帧',
        );
        return call('generate_shot_image', { shotId, replace: true });
      })
      .mockRejectedValueOnce(new Error('模拟中断')),
  });
  expect(interrupted.turn.status).toBe('error');
  const project = commit.mock.lastCall![1];
  expect(project.productionShots?.[0].firstFrameAssetId).toBe('still_new');
  expect(project.scenes[0].timeline?.stillClips).toEqual([original]);
  const run = await runHarness({
    ...options,
    project,
    media,
    session: sessionSchema.parse(interrupted.session),
    liveUpdates: true,
    user: '继续',
    plan: { kind: 'resume' },
    client: vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce(
        call('edit_timeline', {
          nodeId: scene.id,
          command: {
            action: 'append_shot_frame',
            shotId,
            frame: 'first',
          },
        }),
      )
      .mockImplementationOnce(async ({ exchanges }) => {
        expect(exchanges.at(-1)?.replies[0].result.summary).toContain('原位替换');
        return call('edit_timeline', {
          nodeId: scene.id,
          command: {
            action: 'update_still',
            clipId: original.id,
            patch: { assetId: 'still_new' },
          },
        });
      }),
  });
  expect(run.turn.status, run.turn.error).toBe('completed');
  expect(generateShotImage).toHaveBeenCalledOnce();
  expect(commit.mock.lastCall![1].scenes[0].timeline?.stillClips).toEqual([
    { ...original, assetId: 'still_new' },
  ]);
});

it.each(['生成静帧素材然后替换', '把之前的方案做到能在播放器里直接看见，替掉原来那组'])(
  'offers compatible image tools for %s without matching request text',
  async (user) => {
    const { options } = setup([]);
    const client = vi.fn<HarnessOptions['client']>(async ({ tools }) => {
      expect(tools.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['generate_shot_image', 'generate_image_batch']),
      );
      return done;
    });
    const generateShotImage = vi.fn();
    const { turn } = await runHarness({
      ...options,
      user,
      client,
      media: { imageProvider: 'minimax', generateShotImage },
      plan: { kind: 'execute', externalActions: ['image'] },
    });
    expect(turn.status, turn.error).toBe('completed');
    expect(client).toHaveBeenCalledOnce();
    expect(generateShotImage).not.toHaveBeenCalled();
  },
);

it('ends repeated shot rewrites with a partial receipt when the image tool is unavailable', async () => {
  const { options, commit } = setup([]);
  const nodeId = options.project.scenes[0].id;
  options.project.productionShots = [
    { id: 'shot_a', nodeId, label: 'S01', durationMs: 3500 },
    { id: 'shot_b', nodeId, label: 'S02', durationMs: 3500 },
  ];
  const rewrite = (shotId: string, firstFramePrompt: string) =>
    call('edit_production_shot', { action: 'update', shotId, patch: { firstFramePrompt } });
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockResolvedValueOnce(rewrite('shot_a', 'First angle'))
    .mockResolvedValueOnce(rewrite('shot_a', 'Adjusted angle'))
    .mockResolvedValueOnce(rewrite('shot_b', 'Second angle'))
    .mockResolvedValueOnce(rewrite('shot_a', 'First retake'))
    .mockResolvedValueOnce(call('read_story', { action: 'shots', nodeId }))
    .mockResolvedValueOnce(rewrite('shot_b', 'Second retake'))
    .mockImplementationOnce(async ({ tools, system }) => {
      expect(tools.some(({ name }) => name === 'generate_shot_image')).toBe(false);
      expect(system).toContain('若所需工具不可用，直接汇报');
      return rewrite('shot_a', 'Third retake');
    });
  const { turn } = await runHarness({
    ...options,
    user: '为当前节点调整分镜并重新生成分镜图',
    client,
  });
  expect(client).toHaveBeenCalledTimes(7);
  expect(turn).toMatchObject({ outcome: 'partial', committed: true });
  expect(turn.assistant).toContain('连续三轮改写已处理的镜头字段');
  expect(commit.mock.calls[0][1].productionShots).toMatchObject([
    { firstFramePrompt: 'Third retake' },
    { firstFramePrompt: 'Second retake' },
  ]);
});

it('recognizes overlapping graph pages and storyboard reads as already supplied', async () => {
  const { options } = setup([]);
  const chapterId = options.project.chapters[0].id;
  const node = options.project.scenes[0];
  node.storyboardPages = [{ text: '铜灯照着封住的门。', durationMs: 5000 }];
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockImplementationOnce(async ({ system }) => {
      expect(system).toContain(node.storyboardPages![0].text);
      expect(system).toContain('"pageDurationsMs":[5000]');
      return call('read_story', { action: 'topology', chapterId, limit: 3 });
    })
    .mockImplementationOnce(async ({ exchanges }) => {
      expect(exchanges.at(-1)?.replies[0].result).toMatchObject({
        data: { nextOffset: 3 },
        summary: expect.stringContaining('相同查询已返回'),
      });
      return call('read_batch', {
        requests: [
          { tool: 'read_story', args: { action: 'topology', chapterId, offset: 2, limit: 4 } },
          { tool: 'read_story', args: { action: 'read', section: 'storyboard', nodeId: node.id } },
        ],
      });
    })
    .mockImplementationOnce(async ({ system, exchanges }) => {
      expect(system).toContain('已暂停扫图和重复读取');
      expect(exchanges.at(-1)?.replies[0].result.data).toMatchObject({
        results: [{ data: { reused: true } }, { data: { reused: true } }],
      });
      return call('edit_scene', {
        action: 'update',
        nodeId: node.id,
        patch: { title: '修改后的标题' },
      });
    })
    .mockResolvedValueOnce(done);
  const { turn } = await runHarness({ ...options, client });
  expect(turn.status, turn.error).toBe('completed');
  expect(client).toHaveBeenCalledTimes(4);
});

it('allows focused ID reads during expansion, suppresses repeats, and blocks graph scans', async () => {
  const { options } = setup([]);
  const [first, second] = options.project.scenes;
  first.notes = '只有定点补查才会给出的线索';
  second.notes = '另一个节点的线索';
  const detail = { action: 'read', nodeId: first.id, section: 'notes' };
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockImplementationOnce(async ({ tools }) => {
      const spec = tools.find(({ name }) => name === 'read_story');
      expect(spec?.parameters.oneOf).toEqual(
        ['read', 'timeline', 'shot'].map((action) =>
          expect.objectContaining({
            properties: expect.objectContaining({ action: { const: action, type: 'string' } }),
          }),
        ),
      );
      return call('read_story', detail);
    })
    .mockImplementationOnce(async ({ exchanges }) => {
      expect(exchanges.at(-1)?.replies[0].result.data).toMatchObject({ notes: first.notes });
      return call('read_batch', {
        requests: [
          { tool: 'read_story', args: detail },
          { tool: 'read_story', args: { ...detail, nodeId: second.id } },
        ],
      });
    })
    .mockImplementationOnce(async ({ exchanges }) => {
      expect(exchanges.at(-1)?.replies[0].result.data).toMatchObject({
        results: [{ data: { reused: true, nextOffset: null } }, { data: { notes: second.notes } }],
      });
      expect(exchanges.at(-1)?.replies[0].result.data).not.toHaveProperty('results.0.data.notes');
      return call('read_batch', {
        requests: [
          { tool: 'read_story', args: detail },
          { tool: 'read_story', args: { action: 'topology' } },
        ],
      });
    })
    .mockImplementationOnce(async ({ exchanges }) => {
      expect(exchanges.at(-1)?.replies[0].result).toMatchObject({
        ok: false,
        summary: expect.stringContaining('只补查缺失的节点详情'),
      });
      return call('edit_scene', {
        action: 'update',
        nodeId: first.id,
        patch: { title: '扩写后的开头' },
      });
    })
    .mockResolvedValueOnce(done);
  const { turn } = await runHarness({
    ...options,
    user: '请扩写第一章',
    plan: { kind: 'execute', expandStory: true },
    client,
  });
  expect(turn.status, turn.error).toBe('completed');
  expect(turn.committed).toBe(true);
});

it('holds a disconnected new scene in the draft until the route is connected', async () => {
  const { options, commit } = setup([]);
  const onEvent = vi.fn<HarnessOptions['onEvent']>();
  const source = options.project.scenes.find(({ id }) => id === 'scene_reward')!;
  const originalTarget = source.nextId;
  let insertedId = '';
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockResolvedValueOnce(
      call('edit_scene', {
        action: 'create',
        kind: 'video',
        chapterId: source.chapterId,
        title: '新过场',
        notes: '主角离开上一场地点，走向下一个入口。',
        storyboardPages: [{ text: '我伸手碰到门环。' }],
        nextId: originalTarget,
      }),
    )
    .mockImplementationOnce(async ({ exchanges }) => {
      expect(commit).not.toHaveBeenCalled();
      insertedId = exchanges.at(-1)!.replies[0].result.nodeIds![0];
      expect(exchanges.at(-1)?.feedback).toContain(insertedId);
      const preview = onEvent.mock.calls
        .map(([event]) => event)
        .find((event) => event.type === 'blueprintDraft' && event.draft);
      expect(preview).toMatchObject({
        draft: {
          draft: { scenes: expect.arrayContaining([expect.objectContaining({ id: insertedId })]) },
        },
      });
      return done;
    })
    .mockImplementationOnce(async ({ exchanges }) => {
      expect(commit).not.toHaveBeenCalled();
      expect(exchanges.at(-1)?.feedback).toContain('未接入可播放路线');
      return call('edit_scene', { action: 'connect', fromId: source.id, toId: insertedId });
    })
    .mockResolvedValueOnce(done);
  const { turn } = await runHarness({ ...options, client, onEvent, liveUpdates: true });
  expect(turn.status, turn.error).toBe('completed');
  expect(commit).toHaveBeenCalledTimes(1);
  expect(onEvent).toHaveBeenCalledWith({ type: 'blueprintDraft' });
  expect(commit.mock.calls[0][1].scenes.find(({ id }) => id === source.id)?.nextId).toBe(
    insertedId,
  );
});
it('hands a chapter from plot to playable nodes to coordinated shots and player text', async () => {
  const { options, commit } = setup([]);
  const chapterId = options.project.chapters[0].id;
  const source = options.project.scenes.find(({ id }) => id === 'scene_reward')!;
  const plot = '## 场次 1-3 闸门前\n主角从门边取走钥匙，沿林道赶到闸门。';
  const notes = [
    '从哪来｜奖励节点结束后，主角从画左接近闸门。',
    '已知与持有｜已经拿到测试道具，仍在寻找前方声音的来源。',
    '这一段新增什么｜主角取走门边的钥匙，本段完播时入背包。',
    '往哪去｜继续走向闸门，进入条件节点。',
  ].join('\n');
  const provisional = '门边放着一把钥匙。我带走了它。';
  const finalText = '这把钥匙是留给我的？如果有人还在等，我得赶过去。';
  let nodeId: string;
  let itemId!: string;
  const client = vi
    .fn<HarnessOptions['client']>()
    .mockImplementationOnce(async ({ tools }) => {
      expect(tools.map(({ name }) => name)).not.toContain('edit_scene');
      return call('edit_story_design', { target: { stage: 'chapter', chapterId }, text: plot });
    })
    .mockImplementationOnce(async ({ tools }) => {
      const names = tools.map(({ name }) => name);
      expect(names).toContain('edit_game_data');
      expect(names).not.toContain('edit_production_shot');
      const create = call('edit_scene', {
        action: 'create',
        kind: 'video',
        chapterId,
        title: '取走钥匙',
        notes,
        storyboardPages: [{ text: provisional, durationMs: 4000 }],
      });
      const item = call('edit_game_data', {
        action: 'create',
        kind: 'item',
        name: '闸门钥匙',
        description: '从门边取得。',
        initial: 0,
      });
      return { ...create, calls: [...create.calls, ...item.calls] };
    })
    .mockImplementationOnce(async ({ exchanges }) => {
      const outputs = exchanges.at(-1)!.replies;
      nodeId = (outputs[0].result.data as { nodeId: string }).nodeId;
      itemId = (outputs[1].result.data as { id: string }).id;
      const links = call('edit_scene', {
        action: 'batch',
        operations: [
          { action: 'connect', fromId: source.id, toId: nodeId },
          { action: 'connect', fromId: nodeId, toId: source.nextId },
        ],
      });
      const event = call('edit_event', {
        action: 'save',
        nodeId,
        name: '取走钥匙',
        trigger: 'complete',
        atMs: 0,
        once: true,
        effects: [{ kind: 'addItem', itemId, count: 1 }],
      });
      return { ...links, calls: [...links.calls, ...event.calls] };
    })
    .mockResolvedValueOnce(done)
    .mockImplementationOnce(async ({ tools }) => {
      const names = tools.map(({ name }) => name);
      expect(names).toContain('edit_production_shot');
      expect(names).not.toContain('edit_event');
      expect(names).not.toContain('edit_story_design');
      return call('read_story', {
        action: 'playback',
        fromNodeId: source.id,
        nodeIds: [nodeId],
      });
    })
    .mockImplementationOnce(async ({ exchanges }) => {
      expect(exchanges.at(-1)!.replies[0].result.data).toMatchObject({
        nodes: expect.arrayContaining(
          [{ id: source.id }, { id: nodeId }].map((node) => expect.objectContaining(node)),
        ),
      });
      const shot = call('edit_production_shot', {
        action: 'create',
        nodeId,
        label: 'S01',
        durationMs: 4000,
        camera: '视线引导向画右的闸门',
        shotAction: '手取走门边的钥匙。',
      });
      const tamper = call('edit_scene', {
        action: 'batch',
        operations: [{ action: 'update', nodeId, patch: { notes: '改掉既定剧情。' } }],
      });
      return { ...shot, calls: [...shot.calls, ...tamper.calls] };
    })
    .mockResolvedValueOnce(done)
    .mockImplementationOnce(async () =>
      call('edit_scene', {
        action: 'batch',
        operations: [
          {
            action: 'update',
            args: { nodeId, patch: { storyboardPages: [{ text: finalText, durationMs: 4000 }] } },
          },
        ],
      }),
    )
    .mockResolvedValueOnce(done);

  const { turn } = await runHarness({
    ...options,
    user: '写第一章情节剧本，落蓝图并实现道具，再为改动节点拆镜并编排玩家文字',
    plan: {
      kind: 'execute',
      design: { chapter: true, chapters: { kind: 'ordinals', values: [1] } },
      blueprint: { build: true, ordinal: 1 },
      production: { ordinal: 1, scope: 'active' },
    },
    client,
  });
  expect(turn.status, turn.error).toBe('completed');
  expect(commit).toHaveBeenCalledTimes(1);
  const saved = commit.mock.calls[0][1];
  expect(saved.storyDesign?.chapters[0].text).toBe(plot);
  const node = saved.scenes.find(({ title }) => title === '取走钥匙')!;
  expect(node).toMatchObject({
    nextId: source.nextId,
    notes,
    events: [{ effects: [{ kind: 'addItem', itemId, count: 1 }] }],
    storyboardPages: [{ text: finalText, durationMs: 4000 }],
  });
  expect(saved.scenes.find(({ id }) => id === source.id)?.nextId).toBe(node.id);
  expect(saved.items).toContainEqual(expect.objectContaining({ id: itemId, name: '闸门钥匙' }));
  expect(saved.productionShots).toMatchObject([
    { nodeId: node.id, label: 'S01', durationMs: 4000 },
  ]);
  const openingChoice = finish(saved, start(saved));
  const onRoute = finish(saved, choose(saved, openingChoice, 'choice_explore'));
  expect(onRoute.nodeId).toBe(node.id);
  expect(onRoute.inventory[itemId]).toBe(0);
  expect(finish(saved, onRoute).inventory[itemId]).toBe(1);
  expect(turn.traces.filter(({ status }) => status === 'error')).toMatchObject([
    { name: 'edit_scene', result: { ok: false } },
  ]);
  expect(turn.assistant).toContain('已保存制作分镜与玩家剧情文字');
  expect(turn.remaining).toBeUndefined();
});
