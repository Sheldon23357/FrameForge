import { beforeEach, describe, expect, it } from 'vitest';
import { testProject } from '../fixtures/project';
import { SaveRepository, type SaveStorage } from '../../src/features/player/saves';
import { mergeProgress, readProgress, routeStatus } from '../../src/features/player/routes';
import { advance, choose, finish, loadGame, saveGame, start } from '../../packages/runtime/engine';

class MemoryStorage implements SaveStorage {
  values = new Map<string, string>();
  full = false;
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.full) throw new Error('quota');
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
});

describe('player save management', () => {
  it('retains legacy manual slots, provides six manual slots and separates preview data', () => {
    const p = testProject();
    const state = start(p);
    const game = new SaveRepository(storage, p);
    const preview = new SaveRepository(storage, p, true);
    storage.setItem(
      `frameforge.save.${p.id}.0`,
      JSON.stringify({ title: p.scenes[0].title, save: saveGame(p, state) }),
    );
    expect(game.read(0).status).toBe('ready');
    expect(game.list()).toHaveLength(7);
    expect(preview.read(0).status).toBe('empty');
    preview.write(0, state, '试玩', 12000);
    expect(game.read(0).slot?.label).toBeUndefined();
    expect(preview.read(0).slot?.label).toBe('试玩');
  });
  it('preserves exact selection position, variables, inventory and once-events on restore', () => {
    const p = testProject();
    let state = advance(p, start(p), 6000);
    const repo = new SaveRepository(storage, p);
    repo.write(0, state, '抉择之前');
    state = loadGame(p, repo.read(0).slot!.save);
    expect(state.positionMs).toBe(6000);
    expect(state.phase).toBe('choosing');
    state = choose(p, state, 'choice_explore');
    repo.write('auto', state);
    const restored = loadGame(p, repo.read('auto').slot!.save);
    expect(restored.inventory.leaf).toBe(1);
    expect(restored.variables.trust).toBe(45);
    expect(restored.fired).toEqual(state.fired);
    expect(restored.takenChoices).toContain('choice_explore');
  });
  it('distinguishes damaged, incompatible and empty slots without overwriting their content', () => {
    const p = testProject();
    const repo = new SaveRepository(storage, p);
    storage.setItem(`frameforge.save.${p.id}.0`, 'broken JSON');
    const saved = repo.write(1, start(p));
    saved.save.fingerprint = 'obsolete';
    storage.setItem(`frameforge.save.${p.id}.1`, JSON.stringify(saved));
    expect(repo.read(0).status).toBe('corrupt');
    expect(repo.read(1).status).toBe('incompatible');
    expect(repo.read(2).status).toBe('empty');
    expect(storage.getItem(`frameforge.save.${p.id}.0`)).toBe('broken JSON');
    expect(repo.latest()).toBeUndefined();
  });
  it('does not erase the old save when storage is full or an import is invalid', () => {
    const p = testProject();
    const repo = new SaveRepository(storage, p);
    repo.write(0, start(p), '保留');
    const original = storage.getItem(`frameforge.save.${p.id}.0`);
    storage.full = true;
    expect(() => repo.write(0, start(p), '覆盖')).toThrow('原存档仍保留');
    expect(storage.getItem(`frameforge.save.${p.id}.0`)).toBe(original);
    storage.full = false;
    expect(() => repo.import(0, '{}')).toThrow('格式');
    expect(() => repo.import(0, 'bad')).toThrow('JSON');
    const other = new SaveRepository(storage, { ...p, id: 'other' });
    other.write(0, start(p));
    expect(() => repo.import(0, other.export(0))).toThrow('不兼容');
    expect(storage.getItem(`frameforge.save.${p.id}.0`)).toBe(original);
  });
  it('exports and imports a portable save, removes slots, and finds the newest compatible progress', () => {
    const p = testProject();
    const repo = new SaveRepository(storage, p);
    repo.write(0, start(p), '起点', 500);
    const state = choose(p, advance(p, start(p), 6000), 'choice_explore');
    repo.write('auto', state, '', 10000);
    repo.import(5, repo.export('auto'));
    expect(repo.read(5).slot?.playtimeMs).toBe(10000);
    expect(repo.latest()?.save.state.nodeId).toBe('scene_reward');
    repo.remove(5);
    expect(repo.read(5).status).toBe('empty');
  });
  it('loads old saves without choice history and rejects malformed runtime records', () => {
    const p = testProject();
    const saved = saveGame(p, start(p));
    const old = JSON.parse(JSON.stringify(saved));
    delete old.state.takenChoices;
    expect(loadGame(p, old).takenChoices).toEqual([]);
    for (const patch of [
      { takenChoices: ['missing'] },
      { visited: ['missing'] },
      { log: [null] },
      { variables: [] },
      { phase: 'choosing', nodeId: 'scene_neutral' },
    ]) {
      expect(() => loadGame(p, { ...saved, state: { ...saved.state, ...patch } })).toThrow();
    }
  });
});

describe('route overview history', () => {
  it('tracks manual and automatic branch choices, including two options with the same target', () => {
    const p = testProject();
    p.scenes[0].choices[1].targetId = 'scene_reward';
    let state = choose(p, advance(p, start(p), 6000), 'choice_explore');
    state = finish(p, state);
    expect(state.takenChoices).toEqual(['choice_explore', 'choice_secret']);
    const progress = mergeProgress(p, { nodes: [], choices: [] }, state);
    expect(routeStatus(p, state, progress, 'scene_intro', 'choice_explore')).toBe('本局已选');
    expect(routeStatus(p, state, progress, 'scene_intro', 'choice_leave')).toBe('待探索');
  });
  it('retains exploration across new games while locked hidden branches stay unavailable in play', () => {
    const p = testProject();
    p.scenes[0].choices[0].condition = {
      kind: 'variable',
      variableId: 'trust',
      op: 'gte',
      value: 50,
    };
    p.scenes[0].choices[0].hiddenWhenLocked = true;
    const state = start(p);
    expect(
      routeStatus(p, state, { nodes: [], choices: [] }, 'scene_intro', 'choice_explore'),
    ).toBe('待探索');
    const earlier = {
      ...state,
      takenChoices: ['choice_explore'],
      visited: ['scene_intro', 'scene_reward'],
    };
    const progress = mergeProgress(p, { nodes: ['missing'], choices: ['missing'] }, earlier);
    expect(progress.nodes).not.toContain('missing');
    expect(routeStatus(p, state, progress, 'scene_intro', 'choice_explore')).toBe('曾经走过');
    storage.setItem('routes', JSON.stringify(progress));
    expect(readProgress(storage, 'routes')).toEqual(progress);
    storage.setItem('routes', 'bad');
    expect(readProgress(storage, 'routes')).toEqual({ nodes: [], choices: [] });
  });
});
