import { describe, expect, it } from 'vitest';
import { parseProject } from '../../packages/domain/schema';
import { testProject } from '../fixtures/project';
import { fingerprint, loadGame, saveGame, start } from '../../packages/runtime/engine';
import { prepareGameProject } from '../../packages/export/project';

it('includes the interaction question in exports and preserves saves when the question changes', () => {
  const project = parseProject(testProject());
  const opening = project.scenes[0];
  expect(opening.choiceQuestion).toBeUndefined();
  const state = start(project);
  const saved = saveGame(project, state);
  opening.choiceQuestion = '你要往哪里走？';
  const exported = parseProject(JSON.parse(JSON.stringify(prepareGameProject(project))));
  expect(exported.scenes[0].choiceQuestion).toBe(opening.choiceQuestion);
  expect(loadGame(exported, saved)).toEqual(state);
  opening.choiceQuestion = '问'.repeat(21);
  expect(() => parseProject(project)).toThrow();
});

function legacyProject() {
  const p = testProject();
  return {
    ...p,
    formatVersion: 1,
    scenes: p.scenes.map((scene) => {
      const { id, kind, title, chapterId, notes, endingText, ...rest } = scene;
      return {
        id,
        kind,
        title,
        chapter: p.chapters.find((c) => c.id === chapterId)!.title,
        description: kind === 'ending' ? endingText : notes,
        ...rest,
      };
    }),
  };
}

describe('separate private notes and ending copy', () => {
  it('strips private notes from game exports while preserving the editable project and save compatibility', () => {
    const p = testProject();
    p.scenes[4].notes = '内部结局设计';
    const before = JSON.stringify(p);
    const state = start(p);
    const saved = saveGame(p, state);
    const exported = prepareGameProject(p);
    expect(exported.scenes.every((s) => s.notes === '')).toBe(true);
    expect(exported.scenes[4].endingText).toBe(p.scenes[4].endingText);
    expect(JSON.stringify(p)).toBe(before);
    expect(loadGame(exported, saved)).toEqual(state);
  });
  it('preserves legacy video descriptions as notes and ending descriptions as ending copy', () => {
    const original = legacyProject();
    const before = JSON.stringify(original);
    const migrated = parseProject(original);
    expect(migrated.scenes[0].notes).toBe(original.scenes[0].description);
    expect(migrated.scenes[0].endingText).toBe('');
    expect(migrated.scenes[4].endingText).toBe(original.scenes[4].description);
    expect(migrated.scenes[4].notes).toBe('');
    expect(migrated.scenes[0]).not.toHaveProperty('description');
    expect(JSON.stringify(original)).toBe(before);
    expect(parseProject(migrated)).toEqual(migrated);
  });
  it('respects explicitly empty migrated fields instead of resurrecting legacy copy', () => {
    const original = legacyProject();
    const raw = {
      ...original,
      scenes: original.scenes.map((s) => ({ ...s, notes: '', endingText: '' })),
    };
    expect(parseProject(raw).scenes.every((s) => s.notes === '' && s.endingText === '')).toBe(true);
  });
  it('does not invalidate a saved game when only internal notes change', () => {
    const p = testProject();
    const state = start(p);
    const saved = saveGame(p, state);
    const before = fingerprint(p);
    p.scenes[0].notes = '只给作者看的新备注';
    p.scenes[4].notes = '结局节点的内部备注';
    expect(fingerprint(p)).toBe(before);
    expect(loadGame(p, saved)).toEqual(state);
    p.scenes[4].endingText = '新的结局文案';
    expect(() => loadGame(p, saved)).toThrow('不兼容');
  });
  it.each([false, true])(
    'reads legacy save fingerprints with retired timeout fields: %s',
    (countdown) => {
      const old = legacyProject();
      const p = parseProject(old);
      const state = start(p);
      const saved = saveGame(p, state);
      const text = JSON.stringify({
        scenes: countdown
          ? old.scenes.map((scene) =>
              Object.fromEntries(
                Object.entries(scene).flatMap(([key, value]) =>
                  key === 'choiceMode'
                    ? [
                        [key, value],
                        ['timeoutMs', 0],
                      ]
                    : [[key, value]],
                ),
              ),
            )
          : old.scenes,
        variables: old.variables,
        items: old.items,
        startNodeId: old.startNodeId,
        assets: old.assets.map((a) => ({ id: a.id, path: a.path, durationMs: a.durationMs })),
      });
      let hash = 2166136261;
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      saved.fingerprint = (hash >>> 0).toString(16);
      if (countdown) Object.assign(saved.state, { choiceElapsedMs: 1200 });
      expect(loadGame(p, saved)).toEqual(state);
    },
  );
});
