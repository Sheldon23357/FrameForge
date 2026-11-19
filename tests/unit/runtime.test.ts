import { describe, it, expect } from 'vitest';
import { testProject } from '../fixtures/project';
import {
  advance,
  applyEffects,
  availableChoices,
  choose,
  fingerprint,
  finish,
  loadGame,
  saveGame,
  start,
} from '../../packages/runtime/engine';
import { parseProject } from '../../packages/domain/schema';
import { validateProject } from '../../packages/domain/validation';
describe('story engine', () => {
  it('validates the bundled playable example', () => {
    const p = parseProject(testProject());
    expect(validateProject(p)).toEqual([]);
  });
  it('opens choices at the configured media time', () => {
    const p = testProject();
    let s = start(p);
    s = advance(p, s, 5999);
    expect(s.phase).toBe('playing');
    s = advance(p, s, 6000);
    expect(s.phase).toBe('choosing');
  });
  it('stops a fast playback tick at a paused choice before applying later events', () => {
    const p = testProject();
    p.scenes[0].events = [
      {
        id: 'after-choice',
        name: 'After the choice',
        trigger: 'time',
        atMs: 6100,
        once: true,
        effects: [{ kind: 'addVariable', variableId: 'courage', value: 1 }],
      },
    ];
    const initial = start(p);
    const waiting = advance(p, initial, 9000);
    expect(waiting).toMatchObject({
      phase: 'choosing',
      positionMs: 6000,
      variables: initial.variables,
    });
    expect(advance(p, waiting, 9000)).toBe(waiting);

    p.scenes[0].choiceMode = 'continue';
    const continued = advance(p, initial, 6200);
    expect(continued).toMatchObject({ phase: 'choosing', positionMs: 6200 });
    expect(continued.variables.courage).toBe(Number(initial.variables.courage) + 1);
  });
  it('awards an item, changes a stat, consumes the item at a branch and reaches an ending', () => {
    const p = testProject();
    let s = advance(p, start(p), 6000);
    s = choose(p, s, 'choice_explore');
    expect(s.inventory.leaf).toBe(1);
    expect(s.variables.trust).toBe(45);
    s = finish(p, s);
    expect(s.nodeId).toBe('scene_consume');
    expect(s.inventory.leaf).toBe(1);
    s = finish(p, s);
    expect(s.nodeId).toBe('scene_success');
    expect(s.inventory.leaf).toBe(0);
    expect(s.phase).toBe('ended');
  });
  it('routes a player without the item to the fallback ending', () => {
    const p = testProject();
    let s = advance(p, start(p), 6000);
    s = choose(p, s, 'choice_leave');
    expect(s.variables.courage).toBe(5);
    s = advance(p, s, 4500);
    expect(s.variables.courage).toBe(5);
    s = finish(p, s);
    expect(s.variables.courage).toBe(6);
    expect(finish(p, s).variables.courage).toBe(6);
    s = choose(p, s, 'choice_continue');
    expect(s.nodeId).toBe('scene_neutral');
  });
  it('restores a mid-node save without re-running entry effects', () => {
    const p = testProject();
    let s = start(p, 'scene_reward');
    s = advance(p, s, 2500);
    const snapshot = saveGame(p, s);
    const restored = loadGame(p, JSON.parse(JSON.stringify(snapshot)));
    expect(restored.inventory.leaf).toBe(1);
    expect(restored.variables.trust).toBe(45);
    expect(restored.positionMs).toBe(2500);
    expect(restored).toEqual(s);
  });
  it('restores explicitly supported saves and derives newly introduced scores from held evidence', () => {
    const original = testProject();
    const oldState = advance(original, start(original, 'scene_reward'), 2500);
    const oldSave = saveGame(original, oldState);
    const project = structuredClone(original);
    project.variables.push(
      { id: 'deduction', name: '推演', type: 'number', initial: 1, min: 0, max: 2, hidden: false },
      { id: 'reviewed', name: '已复盘', type: 'boolean', initial: false, hidden: true },
    );
    project.saveMigration = {
      targetFingerprint: fingerprint(project),
      fingerprints: [oldSave.fingerprint],
      addVariables: [
        { id: 'deduction', sources: [{ itemId: 'leaf', value: 2 }] },
        { id: 'reviewed', sources: [] },
      ],
    };
    expect(validateProject(parseProject(project))).toEqual([]);
    const restored = loadGame(project, oldSave);
    expect(restored).toEqual({
      ...oldState,
      variables: { ...oldState.variables, deduction: 2, reviewed: false },
    });
    expect(oldSave.state.variables).toEqual(oldState.variables);
    expect(loadGame(project, saveGame(project, restored))).toEqual(restored);
    const intermediate = structuredClone(project);
    intermediate.scenes[0].nextId = 'scene_neutral';
    const reviewed = {
      ...restored,
      variables: { ...restored.variables, deduction: 1, reviewed: true },
    };
    const intermediateSave = saveGame(intermediate, reviewed);
    project.saveMigration.fingerprints.push(intermediateSave.fingerprint);
    expect(loadGame(project, intermediateSave)).toEqual(reviewed);
    expect(() => loadGame(project, { ...oldSave, fingerprint: 'deadbeef' })).toThrow('不兼容');
    project.scenes[0].nextId = 'scene_neutral';
    expect(() => loadGame(project, oldSave)).toThrow('不兼容');
  });
  it('runs one-time events once across repeated visits', () => {
    const p = testProject();
    p.scenes[1].nextId = 'scene_intro';
    let s = start(p, 'scene_reward');
    s = finish(p, s);
    s = advance(p, s, 6000);
    s = choose(p, s, 'choice_explore');
    expect(s.inventory.leaf).toBe(1);
    expect(s.variables.trust).toBe(45);
  });
  it('runs per-visit events on each visit', () => {
    const p = testProject();
    p.scenes[1].events[0].once = false;
    p.scenes[1].nextId = 'scene_intro';
    let s = start(p, 'scene_reward');
    s = finish(p, s);
    s = advance(p, s, 6000);
    s = choose(p, s, 'choice_explore');
    expect(s.inventory.leaf).toBe(2);
  });
  it('rolls back all effects if any inventory debit fails', () => {
    const p = testProject();
    const s = start(p);
    expect(() =>
      applyEffects(p, s, [
        { kind: 'addVariable', variableId: 'trust', value: 20 },
        { kind: 'removeItem', itemId: 'leaf', count: 1 },
      ]),
    ).toThrow('数量不足');
    expect(s.variables.trust).toBe(30);
    expect(s.inventory.leaf).toBe(0);
  });
  it('clamps numeric effects to definition boundaries', () => {
    const p = testProject();
    const s = applyEffects(p, start(p), [{ kind: 'addVariable', variableId: 'trust', value: 999 }]);
    expect(s.variables.trust).toBe(100);
  });
  it('rejects choosing outside the choice phase', () => {
    const p = testProject();
    expect(() => choose(p, start(p), 'choice_explore')).toThrow('选择阶段');
  });
  it('rechecks conditions before applying a choice', () => {
    const p = testProject();
    p.scenes[0].choices[0].condition = { kind: 'item', itemId: 'leaf', op: 'gte', count: 1 };
    const s = advance(p, start(p), 6000);
    expect(() => choose(p, s, 'choice_explore')).toThrow('尚未解锁');
    expect(availableChoices(p, s)[0].enabled).toBe(false);
  });
  it('hides locked choices when configured', () => {
    const p = testProject();
    p.scenes[0].choices[0].condition = { kind: 'item', itemId: 'leaf', op: 'gte', count: 1 };
    p.scenes[0].choices[0].hiddenWhenLocked = true;
    expect(availableChoices(p, advance(p, start(p), 6000))).toHaveLength(1);
  });
  it('fires time events once even with repeated and backward clock samples', () => {
    const p = testProject();
    p.scenes[0].events = [
      {
        id: 'time_test',
        name: 'signal',
        trigger: 'time',
        atMs: 2000,
        once: false,
        effects: [{ kind: 'addVariable', variableId: 'trust', value: 5 }],
      },
    ];
    let s = start(p);
    for (const ms of [1000, 2500, 3000, 1000, 3500]) s = advance(p, s, ms);
    expect(s.variables.trust).toBe(35);
  });
  it('applies an exit event before target entry', () => {
    const p = testProject();
    p.scenes[0].events = [
      {
        id: 'exit_test',
        name: 'exit',
        trigger: 'exit',
        atMs: 0,
        once: false,
        effects: [{ kind: 'addItem', itemId: 'leaf', count: 1 }],
      },
    ];
    const s = choose(p, advance(p, start(p), 6000), 'choice_explore');
    expect(s.inventory.leaf).toBe(2);
  });
  it('drops old timeout settings and waits for the player after the video completes', () => {
    const old = testProject();
    const legacy = {
      ...old,
      scenes: [
        {
          ...old.scenes[0],
          choiceMode: 'continue',
          timeoutMs: 1000,
          timeoutChoiceId: 'choice_leave',
        },
        ...old.scenes.slice(1),
      ],
    };
    const p = parseProject(legacy);
    expect(p.scenes[0]).not.toHaveProperty('timeoutMs');
    expect(p.scenes[0]).not.toHaveProperty('timeoutChoiceId');
    const state = advance(p, start(p), 6000);
    const waiting = advance(p, state, 100000);
    expect(waiting).toMatchObject({ nodeId: 'scene_intro', phase: 'choosing', takenChoices: [] });
    expect(choose(p, waiting, 'choice_leave').nodeId).toBe('scene_alternate');
  });
  it('does not trigger a completion event when a player leaves at an early choice', () => {
    const p = testProject();
    const clearing = p.scenes.find(({ id }) => id === 'scene_alternate')!;
    clearing.choicesAtMs = 1000;
    const choice = advance(p, start(p, clearing.id), 1000);
    const after = choose(p, choice, 'choice_continue');
    expect(after.nodeId).toBe('scene_neutral');
    expect(after.variables.courage).toBe(5);
  });
  it('guards against infinite automatic branch loops', () => {
    const p = testProject();
    p.scenes[3].choices[1].targetId = 'scene_branch';
    expect(() => start(p, 'scene_branch')).toThrow('循环');
    expect(validateProject(p).some((d) => d.message.includes('循环'))).toBe(true);
  });
  it('rejects saves after story rules change, but permits layout changes', () => {
    const p = testProject();
    const save = saveGame(p, start(p));
    p.layout.scene_intro.x += 100;
    expect(() => loadGame(p, save)).not.toThrow();
    p.scenes[0].choices[0].label = 'changed';
    expect(() => loadGame(p, save)).toThrow('不兼容');
  });
  it('rejects corrupt saved inventory', () => {
    const p = testProject();
    const snapshot = saveGame(p, start(p));
    snapshot.state.inventory.leaf = -1;
    expect(() => loadGame(p, snapshot)).toThrow('道具无效');
  });
  it('rejects invalid external format versions and reserved IDs', () => {
    expect(() => parseProject({ ...testProject(), formatVersion: 99 })).toThrow();
    const p = testProject();
    p.scenes[0].id = '__proto__';
    expect(() => parseProject(p)).toThrow();
  });
  it('reports broken references, missing fallback and unsupported variable comparisons', () => {
    const p = testProject();
    p.scenes[0].choices[0].targetId = 'missing';
    p.scenes[3].choices.pop();
    p.variables.push({ id: 'flag', name: '开关', type: 'boolean', initial: false });
    p.scenes[0].choices[1].condition = {
      kind: 'variable',
      variableId: 'flag',
      op: 'gte',
      value: true,
    };
    const errors = validateProject(p).filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
  it('checks event times relative to the trimmed clip', () => {
    const p = testProject();
    p.scenes[0].trimStartMs = 2000;
    p.scenes[0].trimEndMs = 5000;
    p.scenes[0].choicesAtMs = 4000;
    expect(validateProject(p).some((d) => d.message.includes('选项出现时间'))).toBe(true);
  });
});
