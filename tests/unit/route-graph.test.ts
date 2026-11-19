import { describe, expect, it } from 'vitest';
import { testProject } from '../fixtures/project';
import { advance, choose, start } from '../../packages/runtime/engine';
import { buildRouteGraph } from '../../src/features/player/route-graph';

describe('read-only route flowchart', () => {
  it('previews one step when a choice is offered and hides locked secret exits', () => {
    const p = testProject();
    p.scenes[0].choices[0].hiddenWhenLocked = true;
    p.scenes[0].choices[0].condition = {
      kind: 'variable',
      variableId: 'trust',
      op: 'gte',
      value: 50,
    };
    p.scenes[2].choices[0].targetId = p.scenes[0].id;
    const state = advance(p, start(p), 6000);
    const graph = buildRouteGraph(p, state);
    expect(graph.nodes.map((node) => node.scene.id)).toEqual([state.nodeId, 'scene_alternate']);
    expect(graph.nodes[1]).toMatchObject({ preview: true, scene: { title: '未知节点' } });
    expect(graph.edges).toMatchObject([
      { source: state.nodeId, target: 'scene_alternate', preview: true },
    ]);
    expect(JSON.stringify(graph)).not.toContain('奖励节点');
    expect(JSON.stringify(graph)).not.toContain('condition');
    const preview = p.scenes.find((scene) => scene.id === 'scene_alternate')!;
    expect(preview.choices.length).toBeGreaterThan(0);
    expect(graph.edges.some((edge) => edge.source === preview.id)).toBe(false);
  });
  it('retains cross-chapter boundaries when viewing one chapter and never mutates progress', () => {
    const p = testProject();
    p.chapters.push({ id: 'chapter_two', title: '第二章', startNodeId: 'scene_reward' });
    p.scenes[1].chapterId = 'chapter_two';
    const state = choose(p, advance(p, start(p), 6000), 'choice_explore');
    const before = JSON.stringify({ p, state });
    const graph = buildRouteGraph(p, state, 'chapter_two');
    expect(graph.nodes.find((n) => n.scene.id === 'scene_reward')?.external).toBe(false);
    expect(graph.nodes.find((n) => n.scene.id === 'scene_intro')?.external).toBe(true);
    expect(graph.nodes.find((n) => n.scene.id === 'scene_intro')!.x).toBeLessThan(
      graph.nodes.find((n) => n.scene.id === 'scene_reward')!.x,
    );
    expect(graph.edges.find((e) => e.id === 'choice_explore')).toMatchObject({
      target: 'scene_reward',
      preview: false,
      path: expect.stringMatching(/^M .* C /),
    });
    expect(JSON.stringify({ p, state })).toBe(before);
    const firstChapter = buildRouteGraph(p, state, p.chapters[0].id);
    expect(firstChapter.nodes.find((node) => node.scene.id === 'scene_alternate')).toMatchObject({
      preview: true,
      external: false,
    });
    expect(graph.nodes.some((node) => node.scene.id === 'scene_alternate')).toBe(false);
  });
  it('handles empty chapters, disconnected nodes and unfinished exit targets', () => {
    const p = testProject();
    p.chapters.push({ id: 'empty', title: '空章节', startNodeId: '' });
    p.scenes[0].choices[0].targetId = '';
    p.scenes[0].choices[1].targetId = 'missing';
    const state = start(p);
    const graph = buildRouteGraph(p, state);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toEqual([]);
    expect(buildRouteGraph(p, state, 'empty').nodes).toEqual([]);
  });
  it('shows reached nodes in the loaded run while hiding branch rules and unreached nodes', () => {
    const p = testProject();
    p.scenes[2].title = 'SECRET: 道具满3且信任达到50';
    p.scenes[2].notes = 'PRIVATE_AUTHOR_NOTE';
    p.scenes[2].choices[0].label = 'CONDITION: 信任至少50';
    const state = start(p);
    state.visited.push('scene_reward', 'scene_branch');
    const graph = buildRouteGraph(p, state);
    expect(graph.nodes.find((n) => n.scene.id === 'scene_reward')?.scene.title).toBe(
      '奖励节点',
    );
    expect(graph.nodes.find((n) => n.scene.id === 'scene_branch')?.scene.title).toBe('剧情分支');
    expect(graph.edges.map((edge) => edge.id)).toEqual(['next:scene_reward']);
    const output = JSON.stringify(graph);
    for (const secret of [
      'SECRET',
      'CONDITION',
      'PRIVATE_AUTHOR_NOTE',
      p.scenes[3].title,
      'endingLabel',
      'endingText',
      'variableId',
      'itemId',
    ])
      expect(output).not.toContain(secret);
  });
});
