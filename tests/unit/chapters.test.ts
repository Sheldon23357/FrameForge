import { beforeEach, describe, expect, it } from 'vitest';
import { testProject } from '../fixtures/project';
import { useEditor } from '../../src/store/editor';
import { makeProject, parseProject, chapterTitle } from '../../packages/domain/schema';
import { validateProject } from '../../packages/domain/validation';
import { advance, choose, finish, loadGame, saveGame, start } from '../../packages/runtime/engine';

it('converts consecutive legacy choice messages to stable storyboard nodes and keeps other effects', () => {
  const project = testProject();
  const source = project.scenes[0];
  const choice = source.choices[0];
  const target = choice.targetId;
  const score = { kind: 'addVariable', variableId: 'courage', value: 1 } as const;
  const firstText = '甲'.repeat(159) + '🎬' + '乙'.repeat(100);
  const effects = [
    { kind: 'showMessage', title: '线索', text: firstText },
    score,
    { kind: 'showMessage', title: '回应', text: '我记下了线索。' },
  ];
  const legacy = {
    ...project,
    scenes: [
      { ...source, choices: [{ ...choice, effects }, ...source.choices.slice(1)] },
      ...project.scenes.slice(1),
    ],
  };
  const migrated = parseProject(legacy);
  const [first, second] = migrated.scenes.slice(-2);
  expect(migrated.scenes[0].choices[0]).toEqual({
    ...choice,
    targetId: first.id,
  });
  expect(first).toMatchObject({ kind: 'video', chapterId: source.chapterId, nextId: second.id });
  expect(first.storyboardPages?.map((page) => page.text).join('')).toBe(firstText);
  expect(second).toMatchObject({ title: '回应', nextId: target });
  expect(second.events[0]).toMatchObject({ trigger: 'complete', effects: [score] });
  expect(parseProject(legacy)).toEqual(migrated);
  expect(parseProject(migrated)).toEqual(migrated);
});
it('keeps migrated effects on the selected route when two options share a video', () => {
  const project = testProject();
  const [source, target] = project.scenes;
  const [first, second] = source.choices;
  const score = { kind: 'addVariable', variableId: 'courage', value: 2 };
  const migrated = parseProject({
    ...project,
    scenes: [
      {
        ...source,
        choices: [
          { ...first, effects: [score] },
          { ...second, targetId: target.id },
        ],
      },
      ...project.scenes.slice(1),
    ],
  });
  const ready = advance(migrated, start(migrated), 6000);
  const selected = choose(migrated, ready, first.id);
  expect(selected.nodeId).not.toBe(target.id);
  expect(selected.variables.courage).toBe(5);
  const completed = finish(migrated, loadGame(migrated, saveGame(migrated, selected)));
  expect(completed.nodeId).toBe(target.id);
  expect(completed.variables.courage).toBe(7);
  const alternative = choose(migrated, ready, second.id);
  expect(alternative.nodeId).toBe(target.id);
  expect(alternative.variables.courage).toBe(5);
  expect(parseProject(migrated)).toEqual(migrated);
});
describe('chapter migrations', () => {
  it('migrates v2 names in first-seen order, retains links and layout, and prefers the story start as chapter entry', () => {
    const p = testProject();
    const legacy = {
      ...p,
      formatVersion: 2,
      startNodeId: p.scenes[1].id,
      scenes: p.scenes.map(({ chapterId: _id, ...s }, i) => ({
        ...s,
        chapter: i < 3 ? '上篇' : '下篇',
      })),
    };
    const original = JSON.stringify(legacy);
    const migrated = parseProject(legacy);
    expect(migrated.formatVersion).toBe(4);
    expect(migrated.chapters.map((c) => c.title)).toEqual(['上篇', '下篇']);
    expect(migrated.chapters[0].startNodeId).toBe(p.scenes[1].id);
    expect(migrated.scenes[0].choices).toEqual(p.scenes[0].choices);
    expect(migrated.layout).toEqual(p.layout);
    expect(migrated.scenes[0]).not.toHaveProperty('chapter');
    expect(parseProject(migrated)).toEqual(migrated);
    expect(JSON.stringify(legacy)).toBe(original);
  });
  it('preserves distinct legacy groups with whitespace/empty names and avoids existing IDs', () => {
    const p = testProject();
    p.scenes[0].id = 'chapter_legacy_1';
    const migrated = parseProject({
      ...p,
      formatVersion: 2,
      scenes: p.scenes.map(({ chapterId: _id, ...s }, i) => ({
        ...s,
        chapter: ['', '未分章', '  未分章  '][i % 3],
      })),
    });
    expect(migrated.chapters).toHaveLength(3);
    expect(new Set(migrated.chapters.map((c) => c.title)).size).toBe(3);
    expect(migrated.chapters[0].id).not.toBe(p.scenes[0].id);
    expect(parseProject({ ...p, formatVersion: 2, scenes: [] }).chapters[0].startNodeId).toBe('');
  });
  it('rejects malformed legacy names and missing chapter membership in the current format', () => {
    const p = testProject();
    expect(() =>
      parseProject({ ...p, formatVersion: 2, scenes: [{ ...p.scenes[0], chapter: 42 }] }),
    ).toThrow();
    const { chapterId: _id, ...scene } = p.scenes[0];
    expect(() => parseProject({ ...p, scenes: [scene] })).toThrow();
  });
  it('migrates v3 by preserving the old opening scene and placing its chapter first', () => {
    const p = testProject();
    p.chapters.push({ id: 'chapter_two', title: '第二章', startNodeId: 'scene_reward' });
    p.scenes[1].chapterId = 'chapter_two';
    p.scenes[2].chapterId = 'chapter_two';
    const old = { ...p, formatVersion: 3, startNodeId: 'scene_alternate' };
    const before = JSON.stringify(old);
    const result = parseProject(old);
    expect(result.chapters.map((c) => c.id)).toEqual(['chapter_two', p.chapters[0].id]);
    expect(result.chapters[0].startNodeId).toBe('scene_alternate');
    expect(start(result).nodeId).toBe('scene_alternate');
    expect(result.scenes).toEqual(p.scenes);
    expect(JSON.stringify(old)).toBe(before);
    expect(parseProject(result)).toEqual(result);
  });
  it('derives the v4 runtime opening from the first chapter even if an old cached start differs', () => {
    const p = testProject();
    p.chapters[0].startNodeId = 'scene_reward';
    expect(parseProject(p).startNodeId).toBe('scene_reward');
    expect(start(p).nodeId).toBe('scene_reward');
    expect(validateProject(p).some((d) => d.message.includes('第一章'))).toBe(true);
  });
  it('keeps saved game compatibility when migrating a v3 project with a separately chosen opening', () => {
    const p = testProject();
    const saved = saveGame(p, start(p));
    const old = {
      ...p,
      formatVersion: 3,
      chapters: [{ ...p.chapters[0], startNodeId: 'scene_reward' }],
    };
    const migrated = parseProject(old);
    expect(migrated.chapters[0].startNodeId).toBe('scene_intro');
    expect(loadGame(migrated, saved).nodeId).toBe('scene_intro');
  });
});

describe('chapter editing', () => {
  beforeEach(() => useEditor.getState().load(testProject()));
  it('saves empty chapters, inherits the active chapter for new nodes, and initializes its entry', () => {
    const editor = useEditor.getState();
    const id = editor.addChapter('第二章');
    expect(useEditor.getState().activeChapterId).toBe(id);
    expect(parseProject(useEditor.getState().project).chapters[1].startNodeId).toBe('');
    const nodeId = editor.addScene('video', { x: 1, y: 2 }, 'asset_primary');
    const p = useEditor.getState().project;
    expect(p.scenes.at(-1)?.chapterId).toBe(id);
    expect(p.chapters[1].startNodeId).toBe(nodeId);
    expect(p.layout[nodeId]).toEqual({ x: 1, y: 2 });
  });
  it('inherits the selected node chapter in the whole-story view', () => {
    const editor = useEditor.getState();
    const id = editor.addChapter('第二章');
    const first = editor.addScene('ending');
    editor.setChapter(null);
    editor.focusScene(first);
    const next = editor.addScene('video');
    expect(useEditor.getState().project.scenes.find((s) => s.id === next)?.chapterId).toBe(id);
  });
  it('preserves content when organizing chapters and updates the opening when a different chapter becomes first', () => {
    const editor = useEditor.getState();
    const initial = useEditor.getState().project;
    const saved = saveGame(initial, start(initial));
    const nextId = editor.addChapter('第二章');
    editor.renameChapter(initial.chapters[0].id, '序章');
    expect(loadGame(useEditor.getState().project, saved).nodeId).toBe(initial.startNodeId);
    editor.reorderChapter(nextId, -1);
    const result = useEditor.getState().project;
    expect(result.chapters.map((c) => c.title)).toEqual(['第二章', '序章']);
    expect(result.scenes).toEqual(initial.scenes);
    expect(result.startNodeId).toBe('');
    expect(() => loadGame(result, saved)).toThrow('不兼容');
    editor.undo();
    expect(useEditor.getState().project.chapters[0].title).toBe('序章');
    editor.redo();
    expect(useEditor.getState().project.chapters[0].id).toBe(nextId);
  });
  it('rejects duplicate/empty titles and invalid entries without leaving partial history', () => {
    const editor = useEditor.getState();
    const id = editor.addChapter('第二章');
    const before = useEditor.getState().project;
    expect(() => editor.addChapter(' 第二章 ')).toThrow('同名');
    expect(() => editor.renameChapter(id, '   ')).toThrow();
    expect(() => editor.renameChapter(id, '新名字', 'scene_intro')).toThrow('本章');
    expect(() => editor.setChapterEntry(id, 'scene_intro')).toThrow('本章');
    expect(useEditor.getState().project).toBe(before);
  });
  it('moves a node group, repairs chapter starts including the opening, and undoes atomically', () => {
    const editor = useEditor.getState();
    const id = editor.addChapter('第二章');
    const before = useEditor.getState().project;
    const saved = saveGame(before, start(before));
    editor.moveScenes(['scene_intro', 'scene_reward'], id);
    const p = useEditor.getState().project;
    expect(p.chapters[0].startNodeId).toBe('scene_alternate');
    expect(p.chapters[1].startNodeId).toBe('scene_intro');
    expect(p.scenes[0].choices).toEqual(before.scenes[0].choices);
    expect(p.layout).toEqual(before.layout);
    expect(p.startNodeId).toBe('scene_alternate');
    expect(() => loadGame(p, saved)).toThrow('不兼容');
    expect(validateProject(p).filter((d) => d.severity === 'error')).toEqual([]);
    editor.undo();
    expect(useEditor.getState().project).toEqual({
      ...before,
      revision: p.revision + 1,
      updatedAt: expect.any(String),
    });
    editor.redo();
    expect(useEditor.getState().project).toEqual({
      ...p,
      revision: p.revision + 2,
      updatedAt: expect.any(String),
    });
  });
  it('requires a destination for populated chapters and preserves all nodes when deleting a chapter', () => {
    const editor = useEditor.getState();
    const p = useEditor.getState().project;
    const target = editor.addChapter('接收章节');
    expect(() => editor.deleteChapter(p.chapters[0].id)).toThrow('移入');
    editor.deleteChapter(p.chapters[0].id, target);
    const result = useEditor.getState().project;
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0].startNodeId).toBe(p.startNodeId);
    expect(result.scenes).toHaveLength(p.scenes.length);
    expect(result.scenes.every((s) => s.chapterId === target)).toBe(true);
    expect(result.scenes[0].choices).toEqual(p.scenes[0].choices);
    expect(result.startNodeId).toBe(p.startNodeId);
    expect(() => editor.deleteChapter(target)).toThrow('至少');
    editor.undo();
    expect(useEditor.getState().project.chapters).toHaveLength(2);
  });
  it('repairs entry deletion, clears empty chapter entries, and initializes an entirely empty story', () => {
    const p = makeProject();
    const editor = useEditor.getState();
    editor.load(p);
    editor.deleteScenes([p.startNodeId]);
    expect(useEditor.getState().project.chapters[0].startNodeId).toBe('');
    const id = editor.addScene('video');
    expect(useEditor.getState().project.startNodeId).toBe(id);
    expect(useEditor.getState().project.chapters[0].startNodeId).toBe(id);
  });
  it('requires a first-chapter start instead of silently opening another chapter when the first is empty', () => {
    const editor = useEditor.getState();
    editor.load(makeProject());
    const first = useEditor.getState().project.chapters[0].id;
    const firstNode = useEditor.getState().project.startNodeId;
    const second = editor.addChapter('第二章');
    const ending = editor.addScene('ending');
    editor.deleteScenes([firstNode]);
    expect(useEditor.getState().project.startNodeId).toBe('');
    expect(() => start(useEditor.getState().project)).toThrow();
    editor.reorderChapter(second, -1);
    expect(start(useEditor.getState().project).nodeId).toBe(ending);
    editor.deleteChapter(second, first);
    expect(useEditor.getState().project.startNodeId).toBe(ending);
    editor.undo();
    expect(useEditor.getState().project.chapters[0].id).toBe(second);
  });
  it('clears stale scope/selection on undo, project load, and chapter deletion', () => {
    const editor = useEditor.getState();
    const id = editor.addChapter('第二章');
    editor.undo();
    expect(useEditor.getState().activeChapterId).toBeNull();
    editor.redo();
    editor.setChapter(id);
    editor.focusScene('scene_intro');
    expect(useEditor.getState().activeChapterId).toBe(
      useEditor.getState().project.scenes[0].chapterId,
    );
    editor.load(makeProject());
    expect(useEditor.getState().activeChapterId).toBeNull();
  });
});

describe('chapter diagnostics and gameplay', () => {
  it('reports orphan membership, foreign entries, duplicate names and duplicate IDs', () => {
    const p = testProject();
    p.chapters.push({ id: 'other', title: p.chapters[0].title, startNodeId: p.startNodeId });
    p.scenes[1].chapterId = 'missing';
    let messages = validateProject(p)
      .map((d) => d.message)
      .join('\n');
    expect(messages).toContain('同名');
    expect(messages).toContain('空章节');
    expect(messages).toContain('所属章节不存在');
    p.chapters.push({ ...p.chapters[0] });
    messages = validateProject(p)
      .map((d) => d.message)
      .join('\n');
    expect(messages).toContain('重复 ID');
  });
  it('continues across chapter boundaries with shared variables/items and chapter entry previews', () => {
    const p = testProject();
    p.chapters.push({ id: 'chapter_two', title: '第二章', startNodeId: 'scene_reward' });
    p.scenes.slice(1).forEach((s) => {
      s.chapterId = 'chapter_two';
    });
    let state = choose(p, advance(p, start(p), 6000), 'choice_explore');
    expect(state.nodeId).toBe('scene_reward');
    expect(state.variables.trust).toBe(45);
    expect(state.inventory.leaf).toBe(1);
    state = loadGame(parseProject(p), saveGame(p, state));
    state = finish(p, finish(p, state));
    expect(state.nodeId).toBe('scene_success');
    expect(state.inventory.leaf).toBe(0);
    expect(state.phase).toBe('ended');
    expect(start(p, p.chapters[1].startNodeId).nodeId).toBe('scene_reward');
    expect(chapterTitle(p, 'chapter_two')).toBe('第二章');
  });
  it('continues reading v2 game saves after chapter migration', () => {
    const p = testProject();
    const saved = saveGame(p, start(p));
    const legacy = {
      ...p,
      formatVersion: 2,
      scenes: p.scenes.map(({ id, kind, title, chapterId, notes: _notes, ...rest }) => ({
        id,
        kind,
        title,
        chapter: chapterTitle(p, chapterId),
        ...rest,
      })),
    };
    const text = JSON.stringify({
      scenes: legacy.scenes,
      variables: p.variables,
      items: p.items,
      startNodeId: p.startNodeId,
      assets: p.assets.map((a) => ({ id: a.id, path: a.path, durationMs: a.durationMs })),
    });
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    saved.fingerprint = (hash >>> 0).toString(16);
    expect(loadGame(parseProject(legacy), saved).nodeId).toBe('scene_intro');
  });
});
