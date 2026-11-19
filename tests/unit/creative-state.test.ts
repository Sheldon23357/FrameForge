import { expect, it, vi } from 'vitest';
import type { CreativePolicy } from '../../packages/agent/creative-state';
import type { HarnessOptions } from '../../packages/agent/harness';
import { runAgent } from '../fixtures/agent-intent';
import { createEditorTools } from '../../packages/agent/tools';
import { newSession, type ModelFrame } from '../../packages/agent/types';
import { makeProject, makeScene, parseProject, type Project } from '../../packages/domain/schema';
import { designStatus, readDesign, updateDesign } from '../../packages/domain/story-design';
import { prepareGameProject } from '../../packages/export/project';

const openingRequest = '我想做一个一千零一夜题材的黑暗童话的故事';
const settingsRequest = '把当前作品设为《末班信号》，二次元动画，1920×1080，写入工程。';
const reply = (text: string, name?: string, args?: unknown): ModelFrame => ({
  text,
  calls: name ? [{ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) }] : [],
  raw: {},
  finish: 'complete',
});
function start(
  project: Project,
  user: string,
  client: HarnessOptions['client'],
  policy: CreativePolicy = { mode: 'design', target: { stage: 'outline' } },
) {
  const commit = vi.fn<HarnessOptions['commit']>(() => true);
  const options: Parameters<typeof runAgent>[0] = {
    intent: { action: 'start', policy },
    project,
    user,
    client,
    commit,
    session: newSession(project.id),
    provider: 'deepseek',
    model: 'fake',
    runId: 'creative-test',
    selectedIds: [project.startNodeId],
    activeChapterId: null,
    registry: createEditorTools(),
    signal: new AbortController().signal,
    onEvent() {},
  };
  return { options, commit };
}

it('keeps a premise read-only even when the model tries to edit the opening', async () => {
  const project = makeProject();
  let turn = 0;
  const { options, commit } = start(
    project,
    openingRequest,
    async ({ tools, system }) => {
      expect(system).toContain('"stage":"brief"');
      expect(tools.map(({ name }) => name)).not.toContain('edit_scene');
      expect(tools.map(({ name }) => name)).not.toContain('plan_task');
      return turn++ === 0
        ? reply('', 'edit_scene', {
            action: 'update',
            nodeId: project.startNodeId,
            patch: { title: '第一夜' },
          })
        : reply('A. 用故事套出真相。\nB. 每讲完一个故事就失去一段记忆。');
    },
    { mode: 'discuss', target: { stage: 'brief' }, rememberDraft: true },
  );
  const result = await runAgent(options);
  expect(result.turn.traces).toMatchObject([{ name: 'edit_scene', status: 'error' }]);
  expect(result.creativeDraft?.target).toEqual({ stage: 'brief' });
  expect(commit).not.toHaveBeenCalled();
});

it('rejects extra metadata and preserves existing style details', async () => {
  const project = makeProject();
  project.settings.artStyle = { preset: 'realistic', description: '已有详细画风' };
  const args = { title: '末班信号', width: 1920, height: 1080, artStyle: { preset: 'anime' } };
  let step = 0;
  const { options, commit } = start(
    project,
    settingsRequest,
    async ({ tools }) => {
      expect(tools.map(({ name }) => name)).not.toContain('edit_scene');
      switch (step++) {
        case 0:
          return reply('', 'update_project', { ...args, description: '擅自写入简介' });
        case 1:
          return reply('', 'update_project', {
            ...args,
            artStyle: { ...args.artStyle, description: '额外画风' },
          });
        case 2:
          return reply('', 'update_project', args);
        default:
          return reply('已更新设置。');
      }
    },
    {
      mode: 'settings',
      target: { stage: 'brief' },
      fields: ['title', 'width', 'height', 'artStyle'],
    },
  );
  const { turn } = await runAgent(options);
  expect(turn.traces.map(({ status }) => status)).toEqual(['error', 'error', 'done']);
  const written = commit.mock.calls[0][1];
  expect(written).toMatchObject({
    title: '末班信号',
    description: '',
    scenes: project.scenes,
    settings: { artStyle: { preset: 'anime', description: '已有详细画风' } },
  });
});

it('confirms the selected draft across chats, and flags dependent chapter text after an outline revision', async () => {
  const project = makeProject();
  const target = { stage: 'outline' } as const;
  const draft = {
    target,
    text: '第一夜先套问国王。',
    request: '选 A',
    updatedAt: new Date().toISOString(),
  };
  let step = 0;
  const { options, commit } = start(
    project,
    '确认这版大纲',
    async ({ system }) => {
      expect(system).toContain(draft.text);
      switch (step++) {
        case 0:
          return reply('', 'edit_story_design', {
            target,
            text: '替作者重写的正文',
            confirmed: true,
          });
        case 1:
          return reply('', 'edit_story_design', { target, action: 'confirm' });
        default:
          return reply('已确认。');
      }
    },
    { mode: 'design', target, canConfirm: true, source: 'discussion' },
  );
  const { turn } = await runAgent({ ...options, creativeDraft: draft });
  expect(turn.traces.map(({ status }) => status)).toEqual(['error', 'done']);
  const written = parseProject(commit.mock.calls[0][1]);
  expect(written.scenes).toEqual(project.scenes);
  expect(readDesign(written, target)).toMatchObject({ text: draft.text, confirmed: true });
  const chapter = { stage: 'chapter', chapterId: project.chapters[0].id } as const;
  updateDesign(written, chapter, '她在婚房听见脚步声。', true);
  expect(designStatus(written, chapter)).toBe('confirmed');
  updateDesign(written, target, '改为从河岸开场。', false);
  expect(designStatus(written, chapter)).toBe('review');
  expect(prepareGameProject(written)).not.toHaveProperty('storyDesign');
});

it('saves both requested design documents in one turn and preserves draft status', async () => {
  const project = makeProject();
  const brief = { stage: 'brief' } as const;
  const outline = { stage: 'outline' } as const;
  const chapter = { stage: 'chapter', chapterId: project.chapters[0].id } as const;
  const request = '按此大纲把简报和大纲写入工程';
  let step = 0;
  const { options, commit } = start(
    project,
    request,
    async ({ tools }) => {
      expect(tools.some(({ name }) => name === 'edit_scene')).toBe(false);
      if (step++ === 0)
        return reply('', 'edit_story_design', { target: brief, text: '宫闱黑童话。' });
      if (step === 2)
        return reply('', 'edit_story_design', { target: chapter, text: '范围以外。' });
      if (step === 3)
        return reply('', 'edit_story_design', { target: outline, text: '三章单夜剧。' });
      return reply('简报和大纲已保存。');
    },
    { mode: 'design', target: brief, designTargets: [brief, outline] },
  );
  const { turn } = await runAgent(options);
  expect(turn.traces.map(({ status }) => status)).toEqual(['done', 'error', 'done']);
  expect(commit).toHaveBeenCalledTimes(1);
  const written = commit.mock.calls[0][1];
  expect(readDesign(written, brief)).toMatchObject({ text: '宫闱黑童话。', confirmed: false });
  expect(readDesign(written, outline)).toMatchObject({ text: '三章单夜剧。', confirmed: false });
  expect(readDesign(written, chapter)).toBeUndefined();
});

it('confirms both documents using the saved brief and the referenced historical outline', async () => {
  const project = makeProject();
  const brief = { stage: 'brief' } as const;
  const outline = { stage: 'outline' } as const;
  const chapter = { stage: 'chapter', chapterId: project.chapters[0].id } as const;
  const text = '# 《噬骨之夜》全剧大纲草案\n\n三个章节与三个结局。';
  updateDesign(project, brief, '宫闱黑童话。', false);
  const discussion = '聚焦“第一夜生死博弈”的紧凑单夜剧（约 3 章）';
  let step = 0;
  const { options, commit } = start(
    project,
    '确认写入简报和大纲',
    async () => {
      if (step++ === 0) return reply('', 'edit_story_design', { action: 'confirm', target: brief });
      if (step === 2) return reply('', 'edit_story_design', { action: 'confirm', target: outline });
      return reply('已确认两份设计。');
    },
    {
      mode: 'design',
      target: outline,
      designTargets: [brief, outline],
      canConfirm: true,
      discussionTurnId: 'older-outline',
    },
  );
  options.session.turns.push({
    id: 'older-outline',
    user: discussion,
    assistant: text,
    status: 'completed',
    committed: false,
    createdAt: new Date().toISOString(),
    provider: 'deepseek',
    model: 'fake',
    traces: [],
    changedNodeIds: [],
  });
  const { turn } = await runAgent({
    ...options,
    creativeDraft: {
      target: chapter,
      request: discussion,
      text,
      updatedAt: new Date().toISOString(),
    },
  });
  expect(turn.traces.map(({ status }) => status)).toEqual(['done', 'done']);
  expect(commit).toHaveBeenCalledTimes(1);
  const written = commit.mock.calls[0][1];
  expect(readDesign(written, brief)).toMatchObject({ text: '宫闱黑童话。', confirmed: true });
  expect(readDesign(written, outline)).toMatchObject({ text, confirmed: true });
  expect(readDesign(written, chapter)).toBeUndefined();
});

it('writes the existing outline on the suggested handoff phrase and retries the same write after a failed turn', async () => {
  const project = makeProject();
  const target = { stage: 'outline' } as const;
  const text = '# 全剧大纲\n\n七页装订。';
  const request = '按这个大纲进入工程';
  const creativeDraft = {
    target,
    text,
    request: '先写剧情大纲',
    updatedAt: new Date().toISOString(),
  };
  const model = vi.fn<HarnessOptions['client']>(() => {
    throw new Error('保存现成讨论稿无需调用模型。');
  });
  const first = start(project, request, model, { mode: 'design', target, saveDiscussion: true });
  const written = await runAgent({ ...first.options, creativeDraft });
  expect(written.turn).toMatchObject({ committed: true, editCount: 1 });
  expect(readDesign(first.commit.mock.calls[0][1], target)).toMatchObject({
    text,
    confirmed: false,
  });
  expect(first.commit.mock.calls[0][1].scenes).toEqual(project.scenes);
  const retry = start(project, '请把中断的那步接着做', model);
  retry.options.intent = { action: 'resume' };
  const interrupted = await runAgent({
    ...first.options,
    creativeDraft,
    commit: () => ({ error: '写入冲突' }),
  });
  retry.options.session = interrupted.session;
  const retried = await runAgent({
    ...retry.options,
    creativeDraft: { ...creativeDraft, text: '另一份讨论稿' },
  });
  expect(retried.turn.committed).toBe(true);
  expect(readDesign(retry.commit.mock.calls[0][1], target)?.text).toBe(text);
  expect(model).not.toHaveBeenCalled();
});

it('remembers an outline after a conversational choice and recovers it from an older chat', async () => {
  const project = makeProject();
  const target = { stage: 'outline' } as const;
  const brief = {
    target: { stage: 'brief' } as const,
    request: openingRequest,
    text: '## 方向 A\n讲故事。\n\n## 方向 B\n向精灵许愿。',
    updatedAt: '2026-11-13T09:17:33.202Z',
  };
  const text =
    '选 B。下面给你全剧骨架。\n\n## 《盐之城的第九个妹妹》\n\n## 五章骨架\n\n## 第一处分歧放在第一章末\n\n## 结局承诺（三个，不会更多）';
  const draft = start(
    project,
    '好的  就用B吧',
    async ({ system }) => {
      expect(system).toContain('"stage":"outline"');
      return reply(text);
    },
    { mode: 'discuss', target, rememberDraft: true },
  );
  const drafted = await runAgent({ ...draft.options, creativeDraft: brief });
  expect(drafted.creativeDraft).toMatchObject({ target, text });
  const model = vi.fn<HarnessOptions['client']>(() => {
    throw new Error('保存现成大纲无需调用模型。');
  });
  const save = start(project, '把这个大纲写入工程', model, {
    mode: 'design',
    target,
    saveDiscussion: true,
  });
  save.options.intent = {
    action: 'start',
    policy: { mode: 'design', target, saveDiscussion: true, discussionTurnId: drafted.turn.id },
  };
  const saved = await runAgent({ ...save.options, session: drafted.session, creativeDraft: brief });
  expect(saved.turn).toMatchObject({ committed: true, editCount: 1 });
  expect(readDesign(save.commit.mock.calls[0][1], target)).toMatchObject({
    text,
    confirmed: false,
  });
  expect(readDesign(save.commit.mock.calls[0][1], brief.target)).toBeUndefined();
  expect(model).not.toHaveBeenCalled();

  const missing = await runAgent({
    ...save.options,
    intent: { action: 'start', policy: { mode: 'design', target, saveDiscussion: true } },
    creativeDraft: brief,
  });
  expect(missing.turn).toMatchObject({
    committed: false,
    error: expect.stringContaining('找不到'),
  });
});

it('builds chapter structure from the discussed outline and saves each chapter in one commit', async () => {
  const project = makeProject();
  const target = { stage: 'outline' } as const;
  const originalOutline = '旧版五章提案。';
  updateDesign(project, target, originalOutline, true);
  const first = project.chapters[0];
  const text = [
    '# 《第 400 夜》三章结构（修订稿）',
    '## 第一章《铭牌》：入局',
    '三条选择从铭牌开始。',
    '### 关键分歧',
    '交谁的名字？',
    '---',
    '## 第二章《洗衣房的人》：规则',
    '看见铜盆。',
    '---',
    '## 第三章《第 401 夜》：收束',
    '最后一次交名。',
    '## 结局承诺',
    '两个结局。',
  ].join('\n');
  const draft = { target, text, request: '把大纲拆解成三章', updatedAt: new Date().toISOString() };
  const model = vi.fn<HarnessOptions['client']>(() => {
    throw new Error('已有正文无需模型。');
  });
  const request = '按这个三章大纲建结构';
  const { options, commit } = start(project, request, model, {
    mode: 'design',
    target,
    saveChapterStructure: true,
    chapterCount: 3,
  });
  const { turn } = await runAgent({ ...options, creativeDraft: draft });
  expect(turn).toMatchObject({ committed: true, editCount: 3 });
  expect(model).not.toHaveBeenCalled();
  expect(commit).toHaveBeenCalledTimes(1);
  const written = commit.mock.calls[0][1];
  expect(written.chapters.map(({ title }) => title)).toEqual([
    '第一章 · 铭牌',
    '第二章 · 洗衣房的人',
    '第三章 · 第 401 夜',
  ]);
  expect(written.chapters[0].id).toBe(first.id);
  expect(written.scenes).toEqual(project.scenes);
  expect(readDesign(written, target)).toMatchObject({ text: originalOutline, confirmed: true });
  expect(written.storyDesign?.chapters.map(({ text }) => text)).toEqual([
    '三条选择从铭牌开始。\n### 关键分歧\n交谁的名字？',
    '看见铜盆。',
    '最后一次交名。',
  ]);
  const repeated = start(written, request, model, {
    mode: 'design',
    target,
    saveChapterStructure: true,
    chapterCount: 3,
  });
  const result = await runAgent({ ...repeated.options, creativeDraft: draft });
  expect(result.turn).toMatchObject({ committed: false, editCount: 0 });
  expect(repeated.commit).not.toHaveBeenCalled();
});

it('reads a normal sized outline in one call and paginates longer documents', () => {
  const project = makeProject();
  const target = { stage: 'outline' } as const;
  const text = '线索'.repeat(5000);
  updateDesign(project, target, text, false);
  const registry = createEditorTools();
  const context = { project, selectedIds: [], activeChapterId: null, intents: [] };
  const read = (args = {}) =>
    registry.execute('read_story_design', JSON.stringify({ target, ...args }), context).data;
  expect(read()).toMatchObject({ text: text.slice(0, 8000), nextOffset: 8000, truncated: true });
  expect(read({ offset: 8000 })).toMatchObject({ text: text.slice(8000), nextOffset: null });
  expect(read({ limit: 12000 })).toMatchObject({ text, nextOffset: null, truncated: false });
});

it('limits a playable prototype to its chapter and validates branching from that entry', async () => {
  const project = makeProject();
  const chapterId = project.chapters[0].id;
  const other = makeScene('video', 2, 'chapter_second');
  project.scenes.push(other);
  project.chapters.push({ id: other.chapterId, title: '第二章', startNodeId: other.id });
  let action = 0;
  const { options, commit } = start(
    project,
    '按方案 A 帮我先搭一个可玩的第一章',
    async ({ exchanges, tools }) => {
      expect(tools.map(({ name }) => name)).not.toContain('update_project');
      const edits = [
        { action: 'update', nodeId: other.id, patch: { title: '越界' } },
        {
          action: 'update',
          nodeId: project.startNodeId,
          patch: {
            notes: '主角站在王座前，国王停下询问，等主角选择如何回答。',
            storyboardPages: [{ text: '国王等待你的回答。' }],
          },
        },
        {
          action: 'create',
          kind: 'video',
          chapterId,
          title: '说真话',
          notes: '主角说出真相，国王听完垂眼沉默。',
          storyboardPages: [{ text: '国王垂下眼睛。' }],
        },
        {
          action: 'create',
          kind: 'video',
          chapterId,
          title: '讲故事',
          notes: '主角以故事引入，国王示意继续讲。',
          storyboardPages: [{ text: '他示意你讲下去。' }],
        },
      ];
      if (action < edits.length) return reply('', 'edit_scene', edits[action++]);
      if (action < 6) {
        const index = action++ - edits.length;
        const result = exchanges[index + 2].replies[0].result;
        expect(result.ok, result.summary).toBe(true);
        return reply('', 'edit_choice', {
          action: 'add',
          nodeId: project.startNodeId,
          label: index === 0 ? '说真话' : '讲故事',
          targetId: (result.data as { nodeId: string }).nodeId,
        });
      }
      return reply('第一章可以试玩。');
    },
    { mode: 'chapter', target: { stage: 'chapter', chapterId } },
  );
  const { turn } = await runAgent(options);
  expect(turn.status, turn.error).toBe('completed');
  expect(turn.traces[0]).toMatchObject({
    status: 'error',
    result: { summary: expect.stringContaining('超出') },
  });
  expect(commit.mock.calls[0][1].scenes.find(({ id }) => id === other.id)).toEqual(other);
});
