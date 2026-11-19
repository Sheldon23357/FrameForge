import { describe, expect, it } from 'vitest';
import { testProject } from '../fixtures/project';
import {
  advance,
  applyEffects,
  choose,
  finish,
  loadGame,
  saveGame,
  start,
} from '../../packages/runtime/engine';
import { runtimeNoticesSince } from '../../packages/runtime/notifications';
import { describeNotice } from '../../src/features/player/PlayerToasts';

describe('gameplay feedback', () => {
  it('delivers authored story feedback transactionally and preserves valid saved messages', () => {
    const p = testProject();
    const before = start(p);
    const effect = {
      kind: 'showMessage' as const,
      title: '你的观察',
      text: '缺席的绿色自行车说明靖子已经出门。',
    };
    const after = applyEffects(p, before, [effect]);
    expect(after.variables).toEqual(before.variables);
    expect(after.inventory).toEqual(before.inventory);
    expect(runtimeNoticesSince(before, after).map(describeNotice)).toEqual([
      { title: effect.title, detail: effect.text },
    ]);
    expect(runtimeNoticesSince(after, advance(p, after, 100))).toEqual([]);
    expect(loadGame(p, saveGame(p, after))).toEqual(after);
    const snapshot = structuredClone(before);
    expect(() =>
      applyEffects(p, before, [effect, { kind: 'removeItem', itemId: 'leaf', count: 1 }]),
    ).toThrow();
    expect(before).toEqual(snapshot);
    expect(() => applyEffects(p, before, [{ ...effect, text: ' ' }])).toThrow('剧情提示内容无效');
    const corrupt = saveGame(p, after);
    corrupt.state.log.at(-1)!.notice = { kind: 'message', name: '提示', text: '' };
    expect(() => loadGame(p, corrupt)).toThrow('提示记录无效');
  });
  it('reports the event before its item and attribute effects, without replaying them on ticks', () => {
    const p = testProject();
    const before = advance(p, start(p), 6000);
    const after = choose(p, before, 'choice_explore');
    expect(runtimeNoticesSince(before, after)).toEqual([
      { kind: 'event', name: '发放道具' },
      { kind: 'item', name: '测试道具', delta: 1, total: 1 },
      { kind: 'variable', name: '信任', before: 30, after: 45 },
    ]);
    expect(runtimeNoticesSince(after, advance(p, after, 2000))).toEqual([]);
    const approach = finish(p, after);
    expect(runtimeNoticesSince(after, approach)).toEqual([]);
    const ending = finish(p, approach);
    expect(runtimeNoticesSince(approach, ending)).toEqual([
      { kind: 'event', name: '消耗道具' },
      { kind: 'item', name: '测试道具', delta: -1, total: 0 },
    ]);
  });

  it('uses clamped values, skips unchanged attributes, and preserves opposing effects', () => {
    const p = testProject();
    const before = start(p);
    const after = applyEffects(p, before, [
      { kind: 'addVariable', variableId: 'trust', value: 999 },
      { kind: 'addVariable', variableId: 'trust', value: 1 },
      { kind: 'addVariable', variableId: 'courage', value: 2 },
      { kind: 'addVariable', variableId: 'courage', value: -2 },
    ]);
    expect(runtimeNoticesSince(before, after).map(describeNotice)).toEqual([
      { title: '信任 +70', detail: '30 → 100' },
      { title: '勇气 +2', detail: '5 → 7' },
      { title: '勇气 -2', detail: '7 → 5' },
    ]);
  });

  it('formats boolean and text updates and leaves failed transactions silent', () => {
    const p = testProject();
    p.variables.push(
      { id: 'flag', name: '门已开启', type: 'boolean', initial: false },
      { id: 'clue', name: '线索', type: 'string', initial: '' },
    );
    const before = start(p);
    const after = applyEffects(p, before, [
      { kind: 'setVariable', variableId: 'flag', value: true },
      { kind: 'setVariable', variableId: 'clue', value: '北门' },
    ]);
    expect(runtimeNoticesSince(before, after).map(describeNotice)).toEqual([
      { title: '门已开启已更新', detail: '关闭 → 开启' },
      { title: '线索已更新', detail: '空 → 北门' },
    ]);
    const snapshot = structuredClone(before);
    expect(() =>
      applyEffects(p, before, [
        { kind: 'addVariable', variableId: 'trust', value: 5 },
        { kind: 'removeItem', itemId: 'leaf', count: 1 },
      ]),
    ).toThrow();
    expect(before).toEqual(snapshot);
  });

  it('keeps feedback cursors valid after log rollover and supports old save states', () => {
    const p = testProject();
    let before = start(p);
    for (let i = 0; i < 170; i++)
      before = applyEffects(p, before, [
        { kind: 'setVariable', variableId: 'trust', value: i % 2 },
      ]);
    expect(before.log).toHaveLength(150);
    const after = applyEffects(p, before, [
      { kind: 'addVariable', variableId: 'courage', value: 1 },
    ]);
    expect(runtimeNoticesSince(before, after)).toEqual([
      { kind: 'variable', name: '勇气', before: 5, after: 6 },
    ]);
    const old = saveGame(p, before);
    delete old.state.logSequence;
    old.state.log = old.state.log.map(({ message, nodeId }) => ({ message, nodeId }));
    const restored = loadGame(p, old);
    expect(
      runtimeNoticesSince(
        restored,
        applyEffects(p, restored, [{ kind: 'addItem', itemId: 'leaf', count: 2 }]),
      ),
    ).toEqual([{ kind: 'item', name: '测试道具', delta: 2, total: 2 }]);
  });

  it('does not retrigger one-time feedback on a repeat visit and validates saved feedback', () => {
    const p = testProject();
    p.scenes[1].nextId = 'scene_intro';
    const first = start(p, 'scene_reward');
    const returned = advance(p, finish(p, first), 6000);
    expect(runtimeNoticesSince(returned, choose(p, returned, 'choice_explore'))).toEqual([]);
    const saved = saveGame(p, first);
    expect(loadGame(p, saved)).toEqual(first);
    saved.state.log[1].notice = { kind: 'variable', name: '信任', before: 0, after: NaN };
    expect(() => loadGame(p, saved)).toThrow('提示记录无效');
  });
});
