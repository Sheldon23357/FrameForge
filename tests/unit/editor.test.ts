import { beforeEach, describe, expect, it } from 'vitest';
import { testProject } from '../fixtures/project';
import { useEditor } from '../../src/store/editor';
import { validateProject } from '../../packages/domain/validation';
describe('editor commands', () => {
  beforeEach(() => useEditor.getState().load(testProject()));
  it('duplicates a selection while preserving internal links and visited conditions', () => {
    const p = testProject();
    p.scenes[0].choices[0].condition = { kind: 'visited', nodeId: 'scene_reward' };
    useEditor.getState().load(p);
    useEditor.getState().duplicate(['scene_intro', 'scene_reward', 'scene_alternate']);
    const result = useEditor.getState().project;
    const copies = result.scenes.slice(7);
    expect(copies).toHaveLength(3);
    expect(copies[0].choices[0].targetId).toBe(copies[1].id);
    expect(copies[0].choices[0].condition).toEqual({ kind: 'visited', nodeId: copies[1].id });
    expect(validateProject(result).filter((x) => x.severity === 'error')).toEqual([]);
  });
  it('undoes and redoes deletion including all affected connections', () => {
    useEditor.getState().deleteScenes(['scene_reward']);
    expect(useEditor.getState().project.scenes).toHaveLength(6);
    expect(useEditor.getState().project.scenes[0].choices[0].targetId).toBe('');
    useEditor.getState().undo();
    expect(useEditor.getState().project.scenes).toHaveLength(7);
    expect(useEditor.getState().project.scenes[0].choices[0].targetId).toBe('scene_reward');
    useEditor.getState().redo();
    expect(useEditor.getState().project.scenes).toHaveLength(6);
  });
  it('sets the first chapter start as the game opening in one undoable command', () => {
    const editor = useEditor.getState();
    const before = editor.project;
    editor.setChapterEntry(before.chapters[0].id, 'scene_reward');
    const after = useEditor.getState().project;
    expect(after.startNodeId).toBe('scene_reward');
    expect(after.chapters[0].startNodeId).toBe('scene_reward');
    expect(useEditor.getState().past).toHaveLength(1);
    editor.setChapterEntry(before.chapters[0].id, 'scene_reward');
    expect(useEditor.getState().past).toHaveLength(1);
    editor.undo();
    expect(useEditor.getState().project).toEqual({
      ...before,
      revision: after.revision + 1,
      updatedAt: expect.any(String),
    });
    editor.redo();
    expect(useEditor.getState().project).toEqual({
      ...after,
      revision: after.revision + 2,
      updatedAt: expect.any(String),
    });
  });
  it('uses the first chapter entry after changing chapter order, with no separate story setter', () => {
    const editor = useEditor.getState();
    const chapterId = editor.project.chapters[0].id;
    editor.setChapterEntry(chapterId, 'scene_reward');
    expect(useEditor.getState().project.startNodeId).toBe('scene_reward');
    editor.setChapterEntry(chapterId, 'scene_intro');
    const second = editor.addChapter('第二章');
    editor.moveScenes(['scene_reward', 'scene_alternate'], second);
    editor.setChapterEntry(second, 'scene_alternate');
    expect(useEditor.getState().project.startNodeId).toBe('scene_intro');
    editor.reorderChapter(second, -1);
    const result = useEditor.getState().project;
    expect(result.startNodeId).toBe('scene_alternate');
    expect(result.chapters.find((c) => c.id === second)?.startNodeId).toBe('scene_alternate');
    expect(result.chapters.find((c) => c.id === chapterId)?.startNodeId).toBe('scene_intro');
  });
  it('rejects invalid chapter starts without changing project history', () => {
    const editor = useEditor.getState();
    const before = editor.project;
    expect(() => editor.setChapterEntry(before.chapters[0].id, 'missing')).toThrow('本章');
    expect(useEditor.getState().project).toBe(before);
    expect(useEditor.getState().past).toHaveLength(0);
  });
});
