import { expect, it, vi } from 'vitest';
import { checkpointDigest, runAgent, type HarnessOptions } from '../../packages/agent/harness';
import { requestPlanSchema } from '../../packages/agent/request-plan';
import { recoverRollback, rollbackDigest } from '../../packages/agent/rollback';
import { createEditorTools } from '../../packages/agent/tools';
import { newSession, sessionSchema, type ModelFrame } from '../../packages/agent/types';
import { mergeProjectEdits } from '../../packages/domain/project-merge';
import { makeChoice, makeProject, makeScene, parseProject } from '../../packages/domain/schema';
import { automaticBranchLimit } from '../../packages/domain/story-graph';
import { validateProject } from '../../packages/domain/validation';
import { start } from '../../packages/runtime/engine';

const reply: ModelFrame = { text: '已完成。', calls: [], raw: {}, finish: 'complete' };

function tool(name: string, args: unknown): ModelFrame {
  return {
    ...reply,
    text: '',
    calls: [{ name, id: crypto.randomUUID(), arguments: JSON.stringify(args) }],
  };
}

function setup(frames: ModelFrame[], project = makeProject()) {
  const commit = vi.fn<HarnessOptions['commit']>(() => true);
  const options: HarnessOptions = {
    project,
    session: newSession(project.id),
    user: '修改节点标题',
    stagePlan: requestPlanSchema.parse({ kind: 'execute' }),
    provider: 'deepseek',
    model: 'fixture',
    selectedIds: [project.startNodeId],
    activeChapterId: project.chapters[0].id,
    registry: createEditorTools(),
    signal: new AbortController().signal,
    runId: 'transaction-test',
    liveUpdates: true,
    onEvent() {},
    commit,
    client: async () => {
      const frame = frames.shift();
      if (!frame) throw new Error('模拟连接中断');
      return frame;
    },
  };
  return { options, project, commit };
}

it('keeps a replayable checkpoint if the editor applies a batch but cannot save it', async () => {
  const { options, project, commit } = setup([]);
  options.client = async () =>
    tool('edit_scene', {
      action: 'update',
      nodeId: project.startNodeId,
      patch: { title: '续跑应保留' },
    });
  const save = vi
    .fn<NonNullable<HarnessOptions['saveCheckpoint']>>()
    .mockImplementation(async () => {});
  options.saveCheckpoint = save;
  commit.mockImplementationOnce(async () => {
    expect(save).toHaveBeenCalledOnce();
    throw new Error('模拟工程保存中断');
  });
  const failed = await runAgent(options);
  expect(failed.turn.committed).toBe(false);
  expect(failed.session.checkpoint?.baseDigest).toBe(await checkpointDigest(project));
  expect(failed.session.checkpoint?.draft.scenes[0].title).toBe('续跑应保留');

  const restored = await runAgent({
    ...options,
    session: sessionSchema.parse(failed.session),
    user: '继续',
    stagePlan: requestPlanSchema.parse({ kind: 'resume' }),
    client: async () => reply,
  });
  expect(restored.turn.status, restored.turn.error).toBe('completed');
  expect(commit.mock.lastCall?.[1].scenes[0].title).toBe('续跑应保留');
  expect(restored.session.checkpoint).toBeUndefined();
});

it('keeps the first interrupted task after a separate edit in the same conversation', async () => {
  const { options, project } = setup([]);
  const update = (patch: object) =>
    tool('edit_scene', { action: 'update', nodeId: project.startNodeId, patch });
  const firstFrames = [update({ title: '待续跑' })];
  options.client = async () => {
    if (firstFrames.length) return firstFrames.shift()!;
    throw new Error('模拟模型中断');
  };
  const failed = await runAgent({ ...options, user: '原任务' });
  expect(failed.session.checkpoint?.request).toBe('原任务');
  const secondFrames = [update({ endingText: '独立编辑' }), reply];
  const separate = await runAgent({
    ...options,
    session: sessionSchema.parse(failed.session),
    project: failed.session.checkpoint!.draft as typeof project,
    user: '另一项独立编辑',
    client: async () => secondFrames.shift()!,
  });
  expect(separate.turn.status, separate.turn.error).toBe('completed');
  expect(separate.session.checkpoint?.id).toBe(failed.session.checkpoint?.id);
  expect(separate.session.checkpoint?.request).toBe('原任务');
});

it('resumes an earlier checkpoint by ID and leaves the newer independent task pending', async () => {
  const { options, project } = setup([]);
  const suspend = (user: string, session: typeof options.session, patch: object) => {
    const calls = [tool('edit_scene', { action: 'update', nodeId: project.startNodeId, patch })];
    return runAgent({
      ...options,
      liveUpdates: false,
      user,
      session,
      client: async () => {
        if (calls.length) return calls.shift()!;
        throw new Error('模拟连接中断');
      },
    });
  };
  const older = await suspend('修改标题', options.session, { title: '旧任务修改' });
  const newer = await suspend('修改说明', older.session, { notes: '新任务修改' });
  expect(newer.session.suspendedCheckpoints?.[0].id).toBe(older.session.checkpoint?.id);
  const resumed = await runAgent({
    ...options,
    session: sessionSchema.parse(newer.session),
    user: '继续修改标题',
    stagePlan: requestPlanSchema.parse({
      kind: 'resume',
      resumeTaskId: older.session.checkpoint?.id,
    }),
    client: async () => reply,
  });
  expect(resumed.turn.status, resumed.turn.error).toBe('completed');
  expect(resumed.session.checkpoint?.id).toBe(newer.session.checkpoint?.id);
  expect(resumed.session.suspendedCheckpoints).toBeUndefined();
});

it('finalizes a conversation rollback only when the saved project matches the pending target', async () => {
  const { options, project } = setup([reply]);
  const first = await runAgent(options);
  first.turn.rollback = {
    versionId: 'version_target',
    pinnedSceneIds: [],
    creativeDraft: null,
  };
  const followup = await runAgent({
    ...options,
    session: first.session,
    client: async () => reply,
  });
  const before = { ...project, title: '编辑完成但尚未执行回退' };
  const target = { ...project, revision: 10, updatedAt: new Date().toISOString() };
  const journaled = sessionSchema.parse({
    ...followup.session,
    rollbackJournal: {
      turnId: first.turn.id,
      targetDigest: await rollbackDigest(target),
      updatedAt: new Date().toISOString(),
    },
  });
  const beforeCommit = await recoverRollback(journaled, before);
  expect(beforeCommit.turns).toHaveLength(2);
  expect(beforeCommit.rollbackJournal).toBeUndefined();
  const afterCommit = await recoverRollback(journaled, target);
  expect(afterCommit.turns.map(({ id }) => id)).toEqual([first.turn.id]);
  expect(afterCommit.rollbackJournal).toBeUndefined();
});

it('refuses the actual merged candidate when concurrent edits orphan the new scene', async () => {
  const { options, project } = setup([]);
  const middle = makeScene('video', 2);
  const end = makeScene('ending', 3);
  middle.nextId = end.id;
  project.scenes[0].nextId = middle.id;
  project.scenes.push(middle, end);
  const author = structuredClone(project);
  author.scenes[0].nextId = end.id;
  const frames = [
    tool('edit_scene', {
      action: 'insert',
      fromId: middle.id,
      title: '新增过场',
      notes: '从哪来｜中段。已知与持有｜一封信。这一段新增什么｜读信。往哪去｜结局。',
      storyboardPages: [{ text: '她读了信。' }],
    }),
    reply,
  ];
  options.client = async () => frames.shift()!;
  const result = await runAgent({
    ...options,
    commit(base, draft, _intents, verify) {
      const merged = mergeProjectEdits(base, author, draft);
      if ('error' in merged) return merged;
      const error = verify?.(author, merged.project);
      return error ? { error } : true;
    },
  });
  expect(result.turn.status).toBe('conflict');
  expect(result.turn.error).toContain('新增过场');
  expect(result.turn.committed).toBe(false);
});

it('requires both pieces of a request to edit game data and the blueprint', async () => {
  const { options, project, commit } = setup([]);
  options.stagePlan = requestPlanSchema.parse({
    kind: 'execute',
    design: { canEditGameData: true },
    blueprint: { build: false, ordinal: 1 },
  });
  const frames = [
    tool('edit_game_data', {
      action: 'create',
      kind: 'item',
      name: '钥匙',
      description: '房门钥匙',
      initial: 0,
    }),
    tool('edit_scene', {
      action: 'update',
      nodeId: project.startNodeId,
      patch: { title: '发现钥匙' },
    }),
    reply,
  ];
  options.client = async ({ tools }) => {
    expect(tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['edit_scene', 'edit_game_data']),
    );
    return frames.shift()!;
  };
  const done = await runAgent(options);
  expect(done.turn.status, done.turn.error).toBe('completed');
  const candidate = commit.mock.lastCall![1];
  expect(candidate.items.some(({ name }) => name === '钥匙')).toBe(true);
  expect(candidate.scenes[0].title).toBe('发现钥匙');
  expect(done.turn.hostTask?.projectData?.completed).toEqual(['edit_game_data']);
});

it('blocks unplanned file selection and requires specific permission to retry it', async () => {
  const { options } = setup([tool('import_assets', {}), reply]);
  const importAssets = vi.fn(async () => []);
  const result = await runAgent({ ...options, media: { importAssets } });
  expect(importAssets).not.toHaveBeenCalled();
  expect(result.turn.traces[0].result?.ok).toBe(false);
  const frames = [tool('import_assets', { newJob: true }), reply];
  const retry = await runAgent({
    ...options,
    stagePlan: requestPlanSchema.parse({ kind: 'execute', externalActions: ['import'] }),
    media: { importAssets },
    client: async () => frames.shift()!,
  });
  expect(importAssets).not.toHaveBeenCalled();
  expect(retry.turn.traces[0].result?.summary).toContain('明确要求重试');
});

it('holds a blueprint in the draft when players would have no enabled option', async () => {
  const { options, project, commit } = setup([]);
  project.scenes[0].storyboardPages = [{ text: '走到门前。', durationMs: 1000 }];
  const ending = makeScene('ending', 2);
  project.scenes.push(ending);
  project.variables.push({ id: 'door', name: '门已打开', type: 'boolean', initial: false });
  options.stagePlan = requestPlanSchema.parse({
    kind: 'execute',
    blueprint: { build: true, ordinal: 1 },
  });
  const frames = [
    tool('edit_choice', {
      action: 'add',
      nodeId: project.startNodeId,
      label: '走出房间',
      targetId: ending.id,
      hiddenWhenLocked: true,
      conditionJson: JSON.stringify({
        kind: 'variable',
        variableId: 'door',
        op: 'eq',
        value: true,
      }),
    }),
  ];
  options.client = async () => frames.shift() ?? reply;
  const result = await runAgent(options);
  expect(result.turn.status).toBe('error');
  expect(result.turn.error).toContain('没有可点击的选项');
  expect(commit).not.toHaveBeenCalled();
});

it('validates the full node limit and agrees with runtime on automatic branch depth', () => {
  const project = makeProject();
  const chapterId = project.chapters[0].id;
  project.scenes = Array.from({ length: 10000 }, (_, index) => ({
    ...makeScene(index === 9999 ? 'ending' : 'video', index, chapterId),
    id: `scene_${index}`,
    nextId: index === 9999 ? '' : `scene_${index + 1}`,
  }));
  project.startNodeId = project.chapters[0].startNodeId = 'scene_0';
  expect(
    validateProject(parseProject(project)).filter(({ severity }) => severity === 'error'),
  ).toEqual([]);
  const branches = Array.from({ length: automaticBranchLimit + 1 }, (_, index) => ({
    ...makeScene('branch', index, chapterId),
    id: `branch_${index}`,
    choices: [{ ...makeChoice('继续'), targetId: `branch_${index + 1}` }],
  }));
  const end = {
    ...makeScene('ending', branches.length, chapterId),
    id: `branch_${branches.length}`,
  };
  project.scenes = [...branches, end];
  project.startNodeId = project.chapters[0].startNodeId = branches[0].id;
  expect(validateProject(project)).toContainEqual(
    expect.objectContaining({
      severity: 'error',
      message: expect.stringContaining(`超过 ${automaticBranchLimit}`),
    }),
  );
  expect(() => start(project)).toThrow(`超过 ${automaticBranchLimit}`);
  project.startNodeId = project.chapters[0].startNodeId = branches[1].id;
  expect(start(project).nodeId).toBe(end.id);
});
