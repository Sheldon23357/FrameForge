import { describe, it, expect, vi } from 'vitest';
import { createEditorTools, ToolRegistry } from '../../packages/agent/tools';
import { registerBatchReadTool } from '../../packages/agent/tools/batch-read';
import { buildContext, planCompaction, workingReads } from '../../packages/agent/context';
import type { HarnessOptions } from '../../packages/agent/harness';
import { runAgent } from '../fixtures/agent-intent';
import { endingStructureErrors } from '../../packages/agent/deliverables';
import {
  newSession,
  sessionSchema,
  type ModelFrame,
  type ModelRequest,
  type ToolContext,
} from '../../packages/agent/types';
import { defaultAgentSettings } from '../../packages/agent/settings';
import { parseModelFrame, providerRequest } from '../../packages/agent/providers';
import { validateProject } from '../../packages/domain/validation';
import { makeChoice, makeProject, makeScene } from '../../packages/domain/schema';
import { mergeProjectEdits } from '../../packages/domain/project-merge';
import { testProject } from '../fixtures/project';
import { commitAgentTransaction } from '../../src/features/agent/editor-host';
import { useEditor } from '../../src/store/editor';
import { z } from 'zod';

const frame = (
  calls: { name: string; args: unknown; id?: string }[] = [],
  text = '',
): ModelFrame => ({
  text,
  calls: calls.map((c, i) => ({
    id: c.id ?? `call_${i}_${crypto.randomUUID()}`,
    name: c.name,
    arguments: JSON.stringify(c.args),
  })),
  raw: {},
  finish: 'complete',
});
function setup(client: HarnessOptions['client']) {
  const project = testProject();
  const commit = vi.fn<HarnessOptions['commit']>(() => true);
  const options: Parameters<typeof runAgent>[0] = {
    session: newSession(project.id),
    user: '在当前节点添加一个需要钥匙的分支，进入后消耗钥匙。',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    project,
    selectedIds: ['scene_intro'],
    activeChapterId: null,
    registry: createEditorTools(),
    client,
    signal: new AbortController().signal,
    runId: 'run_test',
    commit,
    onEvent: vi.fn(),
  };
  return { options, commit, project };
}
describe('agent tool registry', () => {
  it('requires node content when creating or inserting and reads it separately from player text', () => {
    const project = testProject();
    const source = project.scenes.find(
      (node) => node.kind === 'video' && node.nextId && !node.choices.length,
    )!;
    const target = source.nextId;
    const context: ToolContext = { project, selectedIds: [], activeChapterId: null, intents: [] };
    const registry = createEditorTools();
    const run = (name: string, args: object) =>
      registry.execute(name, JSON.stringify(args), context);
    const storyboardPages = [{ text: '走廊尽头传来一声门响。' }];
    const create = { action: 'create', kind: 'video', title: '夜间走廊', storyboardPages };
    const insert = { action: 'insert', fromId: source.id, title: '夜间走廊', storyboardPages };
    const before = project.scenes.length;
    expect(run('edit_scene', create).ok).toBe(false);
    expect(run('edit_scene', { ...insert, notes: '   ' }).ok).toBe(false);
    expect(context.project.scenes).toHaveLength(before);
    const readNode = (id: string) => context.project.scenes.find((node) => node.id === id);
    expect(readNode(source.id)?.nextId).toBe(target);

    const notes = '深夜，主角从病房踏入昏暗走廊。\n他听见门响才回头，尚未看见来人。';
    const inserted = run('edit_scene', { ...insert, notes });
    expect(inserted.ok).toBe(true);
    const { nodeId } = inserted.data as { nodeId: string };
    expect(readNode(source.id)?.nextId).toBe(nodeId);
    expect(readNode(nodeId)).toMatchObject({ nextId: target });
    expect(run('read_story', { action: 'read', nodeId, section: 'notes' }).data).toMatchObject({
      notes,
      nextOffset: null,
    });
    expect(
      run('read_story', { action: 'read', nodeId, section: 'storyboard' }).data,
    ).not.toHaveProperty('notes');
  });

  it('creates, reads, edits and clears a shared question for player choices', () => {
    const project = testProject();
    const context: ToolContext = { project, selectedIds: [], activeChapterId: null, intents: [] };
    const registry = createEditorTools();
    const run = (name: string, args: object) =>
      registry.execute(name, JSON.stringify(args), context);
    const question = '你要先查哪里？';
    const created = run('edit_scene', {
      action: 'create',
      kind: 'video',
      title: '调查',
      notes: '夜里，主角停在门内，听见走廊脚步，转身决定从哪查起。',
      storyboardPages: [{ text: '门外传来了脚步声。' }],
      choiceQuestion: question,
    });
    expect(created.ok).toBe(true);
    const { nodeId } = created.data as { nodeId: string };
    const read = () => run('read_story', { action: 'read', section: 'choices', nodeId }).data;
    const update = (patch: object) => run('edit_scene', { action: 'update', nodeId, patch });
    expect(read()).toMatchObject({ choiceQuestion: question });
    expect(run('read_story', { action: 'list', query: question }).data).toMatchObject({ total: 1 });
    expect(update({ notes: '作者备注' }).ok).toBe(true);
    expect(read()).toMatchObject({ choiceQuestion: question });
    const limit = '问'.repeat(20);
    expect(update({ choiceQuestion: limit }).ok).toBe(true);
    expect(update({ choiceQuestion: limit + '？' }).ok).toBe(false);
    expect(read()).toMatchObject({ choiceQuestion: limit });
    expect(update({ choiceQuestion: '' }).ok).toBe(true);
    expect(read()).toMatchObject({ choiceQuestion: undefined });
    expect(
      run('edit_scene', {
        action: 'create',
        kind: 'branch',
        title: '自动判定',
        notes: '按是否发现证据选择下一处调查地点。',
        choiceQuestion: question,
      }).ok,
    ).toBe(false);
  });

  it('requires a playable ending scene before a separate ending summary', () => {
    const project = testProject();
    const opening = project.scenes[0];
    const ending = makeScene('ending', 1, opening.chapterId);
    project.scenes.push(ending);
    opening.choices[0].targetId = ending.id;
    expect([...endingStructureErrors(project).values()].join('\n')).toContain('独立结局剧情视频');
    const finalScene = makeScene('video', 1, opening.chapterId);
    finalScene.storyboardPages = [{ text: '她把最后一封信交给了你。', durationMs: 3000 }];
    finalScene.nextId = ending.id;
    opening.choices[0].targetId = finalScene.id;
    project.scenes.push(finalScene);
    expect([...endingStructureErrors(project).keys()]).not.toContain(`ending:${ending.id}`);
    expect([...endingStructureErrors(project).keys()].some((key) => key.endsWith(ending.id))).toBe(
      false,
    );
  });
  it('advertises flat scene arguments and accepts typed numeric literals at the tool boundary', () => {
    const project = testProject();
    const context: ToolContext = { project, selectedIds: [], activeChapterId: null, intents: [] };
    const registry = createEditorTools();
    const spec = registry.specs().find((tool) => tool.name === 'edit_scene')?.parameters;
    expect(spec).toHaveProperty('oneOf.0.properties.title');
    expect(spec).toHaveProperty('oneOf.5.properties.operations.maxItems', 8);
    expect(spec).not.toHaveProperty('oneOf.0.properties.args');
    const run = (name: string, args: object) =>
      registry.execute(name, JSON.stringify(args), context);
    expect(
      run('edit_scene', {
        action: 'create',
        kind: 'ending',
        title: '扁平格式结局',
        notes: '以案件结清收束。',
      }).ok,
    ).toBe(true);
    expect(
      run('edit_scene', {
        action: 'update',
        args: {
          nodeId: 'scene_intro',
          patch: { storyboardPages: [{ text: '继续向前', durationMs: '3000' }] },
        },
      }).ok,
    ).toBe(true);
    expect(
      context.project.scenes.find(({ id }) => id === 'scene_intro')?.storyboardPages?.[0]
        .durationMs,
    ).toBe(3000);
    const targetId = 'scene_consume';
    expect(
      run('edit_event', {
        action: 'save',
        nodeId: targetId,
        name: '获得树叶',
        trigger: 'complete',
        atMs: 0,
        once: false,
        effects: [{ kind: 'addItem', itemId: 'leaf', count: '2' }],
      }).ok,
    ).toBe(true);
    expect(
      context.project.scenes.find(({ id }) => id === targetId)?.events.at(-1)?.effects,
    ).toEqual([{ kind: 'addItem', itemId: 'leaf', count: 2 }]);
    expect(
      run('edit_scene', {
        action: 'update',
        nodeId: 'scene_intro',
        patch: { timeoutMs: 1500, notes: '保留合法字段' },
      }).ok,
    ).toBe(true);
    expect(context.project.scenes[0].notes).toBe('保留合法字段');
    expect(context.project.scenes[0]).not.toHaveProperty('timeoutMs');
    expect(JSON.stringify(spec)).not.toContain('timeoutMs');
  });

  it('explores real clickable routes without asking the model to supply choice IDs', () => {
    const project = makeProject();
    const [opening] = project.scenes;
    const left = makeScene('ending', 2);
    const right = makeScene('ending', 3);
    project.scenes.push(left, right);
    opening.choices = [
      { ...makeChoice('走左边'), targetId: left.id },
      { ...makeChoice('走右边'), targetId: right.id },
    ];
    const registry = createEditorTools();
    const context = { project, selectedIds: [], activeChapterId: null, intents: [] };
    const firstPage = registry.execute(
      'check_story',
      '{"action":"explore","args":{"limit":1}}',
      context,
    );
    expect(firstPage.ok).toBe(true);
    expect(firstPage.data).toMatchObject({
      distinctChoices: true,
      endings: 2,
      failureCount: 0,
      nextOffset: 1,
      findings: [{ kind: 'ending', nodeId: left.id, choiceIds: [opening.choices[0].id] }],
    });
    opening.choices[1].targetId = opening.id;
    opening.choices[0].targetId = right.id;
    expect(registry.execute('check_story', '{"action":"explore"}', context).data).toMatchObject({
      endings: 1,
      failureCount: 0,
    });
    opening.choices[0].targetId = opening.id;
    expect(registry.execute('check_story', '{"action":"explore"}', context).data).toMatchObject({
      endings: 0,
      failureCount: 1,
    });
    opening.kind = 'branch';
    expect(
      registry.execute(
        'check_story',
        JSON.stringify({
          action: 'simulate',
          choiceIds: [opening.choices[0].id],
        }),
        context,
      ),
    ).toMatchObject({ ok: false, summary: expect.stringContaining('自动条件分支') });
  });

  it('summarizes route simulation and choice impact without returning full traces', () => {
    const project = makeProject();
    const [opening] = project.scenes;
    const ending = makeScene('ending', 2);
    project.scenes.push(ending);
    const choice = { ...makeChoice('继续'), targetId: ending.id };
    opening.choices = [choice];
    const context = { project, selectedIds: [], activeChapterId: null, intents: [] };
    const registry = createEditorTools();
    const check = (args: object) => registry.execute('check_story', JSON.stringify(args), context);
    const simulation = { action: 'simulate', choiceIds: [choice.id] };
    const summary = check({ ...simulation, detail: 'summary' });
    expect(summary.data).toMatchObject({
      nodeId: ending.id,
      phase: 'ended',
      ending: true,
      availableChoiceIds: [],
    });
    expect(summary.data).not.toHaveProperty('trace');
    expect(check({ ...simulation, detail: 'trace', limit: 1 }).data).toMatchObject({
      nextOffset: 1,
      trace: [{ action: 'start' }],
    });
    const impact = check({
      action: 'inspect_choice',
      nodeId: opening.id,
      choiceId: choice.id,
      section: 'summary',
    });
    expect(impact.data).toMatchObject({ possibleEndingCount: 1, target: { id: ending.id } });
    expect(impact.data).not.toHaveProperty('entries');
  });

  it('simulates waiting through playback without selecting a legacy default choice', () => {
    const project = testProject();
    Object.assign(project.scenes[0], {
      choiceMode: 'continue',
      timeoutMs: 100,
      timeoutChoiceId: 'choice_leave',
    });
    const result = createEditorTools().execute(
      'check_story',
      JSON.stringify({ action: 'simulate', steps: [{ action: 'wait', durationMs: 20000 }] }),
      { project, selectedIds: [], activeChapterId: null, intents: [] },
    );
    expect(result.data).toMatchObject({
      nodeId: 'scene_intro',
      phase: 'choosing',
      takenChoiceIds: [],
      trace: expect.arrayContaining([
        {
          action: 'wait',
          positionMs: 9000,
          nodeId: 'scene_intro',
          fromNodeId: 'scene_intro',
          phase: 'choosing',
          enteredNodeIds: [],
          variables: [],
          inventory: [],
        },
      ]),
    });
  });

  it('accepts explicit game-data create and update actions and returns real IDs', () => {
    const project = testProject();
    const context: ToolContext = { project, selectedIds: [], activeChapterId: null, intents: [] };
    const registry = createEditorTools();
    const edit = (args: object) =>
      registry.execute('edit_game_data', JSON.stringify(args), context);
    const variable = { kind: 'variable', name: '好感度', type: 'number', initial: 0 };
    const create = edit({ action: 'create', id: 'model_supplied_id', ...variable, initial: '0' });
    expect(create.ok).toBe(true);
    expect(create.data).toMatchObject({ initial: 0 });
    const { id } = create.data as { id: string };
    expect(id).toMatch(/^variable_/);
    expect(edit({ action: 'update', ...variable })).toMatchObject({
      ok: false,
      summary: expect.stringContaining('真实 ID'),
    });
    expect(edit({ action: 'update', ...variable, id, initial: 5 }).data).toMatchObject({
      id,
      initial: 5,
    });
    expect(
      edit({ action: 'create', kind: 'item', name: '猫铃', description: '', initial: '0' }),
    ).toMatchObject({
      ok: true,
      data: { id: expect.stringMatching(/^item_/), initial: 0 },
    });
    expect(
      edit({ action: 'create', kind: 'item', name: '猫铃', description: '', initial: '零' }),
    ).toMatchObject({
      ok: false,
      summary: expect.stringContaining('initial'),
    });
    expect(
      edit({ kind: 'variable', name: '测试开关', type: 'boolean', initial: 'false' }).data,
    ).toMatchObject({ initial: false });
    expect(
      edit({ kind: 'variable', name: '测试文本', type: 'string', initial: '0' }).data,
    ).toMatchObject({ initial: '0' });
    expect(context.project.variables.filter((row) => row.name === variable.name)).toHaveLength(1);
  });

  it('batches attributes and items while preserving IDs and rejecting referenced deletions', () => {
    const context: ToolContext = {
      project: testProject(),
      selectedIds: [],
      activeChapterId: null,
      intents: [],
    };
    const registry = createEditorTools();
    const batch = (operations: object[]) =>
      registry.execute('edit_game_data', JSON.stringify({ action: 'batch', operations }), context);
    const variable = { kind: 'variable', name: '好感度', type: 'number', initial: '0' };
    const item = { kind: 'item', name: '铜镜', description: '', initial: '1' };
    const created = batch([variable, item]);
    expect(created.ok).toBe(true);
    const [attribute, prop] = (created.data as { results: { id: string }[] }).results;
    expect(attribute.id).toBe(
      context.project.variables.find(({ name }) => name === variable.name)?.id,
    );
    expect(prop.id).toBe(context.project.items.find(({ name }) => name === item.name)?.id);

    const edited = batch([
      { ...variable, action: 'update', id: attribute.id, initial: '5' },
      { action: 'delete', kind: 'variable', id: 'courage' },
      { action: 'delete', kind: 'item', id: prop.id },
    ]);
    expect(edited).toMatchObject({
      ok: true,
      data: {
        results: [
          { index: 0, ok: true, id: attribute.id },
          { index: 1, ok: false, summary: expect.stringContaining('仍被剧情引用') },
          { index: 2, ok: true, id: prop.id },
        ],
      },
    });
    expect(context.project.variables.find(({ id }) => id === attribute.id)?.initial).toBe(5);
    expect(context.project.variables.some(({ id }) => id === 'courage')).toBe(true);
    expect(context.project.items.some(({ id }) => id === prop.id)).toBe(false);
  });

  it('defaults Agent-created storyboard pages to three seconds and preserves explicit durations', () => {
    const project = testProject();
    const context: ToolContext = { project, selectedIds: [], activeChapterId: null, intents: [] };
    const result = createEditorTools().execute(
      'edit_scene',
      JSON.stringify({
        action: 'create',
        args: {
          kind: 'video',
          title: '故事板测试',
          notes: '分两段演出，先发现异样，再正面应对。',
          storyboardPages: [{ text: '第一幕' }, { text: '第二幕', durationMs: 6000 }],
        },
      }),
      context,
    );
    expect(result.ok, result.summary).toBe(true);
    expect(context.project.scenes.at(-1)?.storyboardPages?.map((page) => page.durationMs)).toEqual([
      3000, 6000,
    ]);
  });

  it('reads story text and links together and resumes at the next complete node', () => {
    const project = testProject();
    const [first, second] = project.scenes;
    project.scenes = [first, second];
    first.storyboardPages = [{ text: '甲'.repeat(160), durationMs: 9000 }];
    second.storyboardPages = [{ text: '乙'.repeat(160), durationMs: 9000 }];
    first.nextId = second.id;
    const registry = createEditorTools();
    const context: ToolContext = { project, selectedIds: [], activeChapterId: null, intents: [] };
    const read = (offset: number, readPageCharacters: number) =>
      registry.execute('read_story', JSON.stringify({ action: 'overview', offset }), {
        ...context,
        readPageCharacters,
      });
    const full = read(0, 32000);
    expect(full.data).toMatchObject({
      nextOffset: null,
      nodes: [
        { id: first.id, nextId: second.id, pages: ['甲'.repeat(160)], pageDurationsMs: [9000] },
        { id: second.id, pages: ['乙'.repeat(160)] },
      ],
    });
    const page = read(0, 650);
    expect(page.data).toMatchObject({ nextOffset: 1, nodes: [{ id: first.id }] });
    expect(read(1, 32000).data).toMatchObject({ offset: 1, nodes: [{ id: second.id }] });
    expect(read(0, 200)).toMatchObject({ ok: false, data: { nextOffset: 0, nodeId: first.id } });
  });

  it('combines independent reads with item-level errors and an explicit next page', () => {
    const project = testProject();
    project.scenes[0].notes = 'a'.repeat(9000);
    const context: ToolContext = { project, selectedIds: [], activeChapterId: null, intents: [] };
    const registry = createEditorTools();
    const note = {
      tool: 'read_story',
      args: { action: 'read', args: { nodeId: project.scenes[0].id, section: 'notes' } },
    };
    const requests = [
      { tool: 'read_story', args: { action: 'read', args: { nodeId: 'missing' } } },
      ...Array.from({ length: 7 }, () => note),
    ];
    const run = (offset = 0) =>
      registry.execute('read_batch', JSON.stringify({ requests, offset }), context).data as {
        results: { index: number; ok: boolean; data?: unknown }[];
        nextOffset: number | null;
        truncated: boolean;
        truncatedItems: { index: number; tool: string; originalCharacters: number }[];
      };
    expect(
      registry.execute('read_batch', JSON.stringify({ requests }), {
        ...context,
        readPageCharacters: 6000,
      }).data,
    ).toMatchObject({ nextOffset: 2, results: [{ index: 0 }, { index: 1 }] });
    const first = run();
    expect(first.results[0]).toMatchObject({ index: 0, ok: false });
    expect(first.results[1]).toMatchObject({ ok: true, data: { notes: 'a'.repeat(4000) } });
    expect(first.truncatedItems).toEqual([]);
    expect(first.nextOffset).toBe(5);
    const seen = [...first.results];
    for (let offset = first.nextOffset; offset !== null;) {
      const page = run(offset);
      seen.push(...page.results);
      offset = page.nextOffset;
    }
    expect(seen.map((result) => result.index)).toEqual(requests.map((_, i) => i));
    expect(run(7)).toMatchObject({
      nextOffset: null,
      truncated: false,
      truncatedItems: [],
    });
    expect(
      registry.execute(
        'read_batch',
        JSON.stringify({ requests: [note, { tool: 'edit_scene' }] }),
        context,
      ).ok,
    ).toBe(false);
  });

  it('delivers a batch above 14,000 characters to the model and pages past an oversized item', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_payload',
      label: '测试读取',
      group: 'context',
      mode: 'read',
      description: '测试响应长度。',
      schema: z.object({ length: z.number().int().nonnegative() }),
      execute: (_context, { length }) => ({
        ok: true,
        summary: '读取成功',
        data: { text: 'a'.repeat(length) },
      }),
    });
    registerBatchReadTool(registry);
    const requests = [9700, 9950, 20050, 15].map((length) => ({
      tool: 'read_payload',
      args: { length },
    }));
    const { options } = setup(async ({ exchanges }) => {
      if (!exchanges.length) return frame([{ name: 'read_batch', args: { requests } }]);
      if (exchanges.length === 1) {
        expect(exchanges[0].replies[0].result.data).toMatchObject({ nextOffset: 2 });
        return frame([{ name: 'read_batch', args: { requests, offset: 2 } }]);
      }
      return frame([], '读取完成');
    });
    const { turn } = await runAgent({ ...options, registry });
    expect(turn.status).toBe('completed');
    const [first, second] = turn.traces.map(({ result }) => result);
    expect(JSON.stringify(first).length).toBeGreaterThan(14000);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(20000);
    expect(first?.data).toMatchObject({
      nextOffset: 2,
      truncatedItems: [],
      results: requests.slice(0, 2).map(({ args }, index) => ({
        index,
        data: { text: 'a'.repeat(args.length) },
      })),
    });
    expect(second?.data).toMatchObject({
      nextOffset: null,
      truncated: true,
      truncatedItems: [{ index: 2, tool: 'read_payload', originalCharacters: expect.any(Number) }],
      results: [
        { index: 2, data: { truncated: true, originalCharacters: expect.any(Number) } },
        { index: 3, data: { text: 'a'.repeat(15) } },
      ],
    });
  });

  it('saves authored cues on tenths without pushing an in-range cue beyond the clip', () => {
    const project = testProject();
    const node = project.scenes[0];
    node.trimEndMs = 6056;
    node.choicesAtMs = 5036;
    const c: ToolContext = {
      project,
      selectedIds: [node.id],
      activeChapterId: null,
      intents: [],
      history: [],
    };
    const registry = createEditorTools();
    const update = (patch: object) =>
      registry.execute(
        'edit_scene',
        JSON.stringify({ action: 'update', args: { nodeId: node.id, patch } }),
        c,
      );
    expect(update({ title: '旧节点' }).ok).toBe(true);
    expect(c.project.scenes[0].choicesAtMs).toBe(5036);
    expect(update({ choicesAtMs: 5036 }).ok).toBe(true);
    expect(c.project.scenes[0].choicesAtMs).toBe(5000);
    const event = {
      nodeId: node.id,
      name: '片尾提醒',
      trigger: 'time',
      atMs: 6056,
      once: true,
      effects: [],
    };
    expect(registry.execute('edit_event', JSON.stringify({ action: 'save', ...event }), c).ok).toBe(
      true,
    );
    expect(c.project.scenes[0].events[0].atMs).toBe(6000);
    expect(
      validateProject(c.project).filter((issue) => issue.message.includes('片段长度')),
    ).toEqual([]);
  });

  it('finds downstream choice references and state changes without scanning unrelated routes', () => {
    const project = testProject();
    const source = project.scenes.find((scene) => scene.id === 'scene_intro')!;
    const add = (kind: 'video' | 'branch' | 'ending', id: string) => {
      const scene = { ...makeScene(kind, 1, source.chapterId), id, title: id };
      project.scenes.push(scene);
      return scene;
    };
    const hop = add('video', 'impact_hop');
    const gate = add('branch', 'impact_gate');
    const end = add('ending', 'impact_end');
    const loop = add('video', 'impact_loop');
    const ignored = add('video', 'impact_unrelated');
    hop.nextId = gate.id;
    loop.nextId = gate.id;
    const flag = { kind: 'setVariable' as const, variableId: 'impact_flag', value: true };
    hop.events = [
      {
        id: 'impact_gain',
        name: '取得线索',
        trigger: 'complete',
        atMs: 0,
        once: false,
        effects: [flag],
      },
    ];
    const choice = { ...makeChoice('查线索'), targetId: hop.id };
    source.choices = [choice];
    const conditional = {
      ...makeChoice('验证线索'),
      targetId: end.id,
      condition: {
        kind: 'all' as const,
        children: [
          {
            kind: 'variable' as const,
            variableId: flag.variableId,
            op: 'eq' as const,
            value: true,
          },
          { kind: 'not' as const, child: { kind: 'visited' as const, nodeId: hop.id } },
        ],
      },
    };
    gate.choices = [
      conditional,
      { ...makeChoice('兜底'), targetId: loop.id },
      { ...conditional, id: 'shadowed' },
    ];
    ignored.choices = [{ ...conditional, id: 'unrelated' }];
    end.events = [
      {
        id: 'impact_reset',
        name: '重置状态',
        trigger: 'enter',
        atMs: 0,
        once: true,
        effects: [{ ...flag, value: false }],
      },
      {
        id: 'impact_never_exit',
        name: '未执行事件',
        trigger: 'exit',
        atMs: 0,
        once: true,
        effects: [flag],
      },
    ];
    const context: ToolContext = {
      project,
      selectedIds: [source.id],
      activeChapterId: null,
      intents: [],
    };
    const before = structuredClone(project);
    const registry = createEditorTools();
    const inspect = (args: object) => {
      const result = registry.execute(
        'check_story',
        JSON.stringify({ action: 'inspect_choice', args: args }),
        context,
      );
      expect(result.ok, result.summary).toBe(true);
      return result.data;
    };
    expect(inspect({ query: '查线索' })).toMatchObject({
      section: 'choices',
      total: 1,
      entries: [{ id: choice.id }],
    });
    expect(inspect({ choiceId: choice.id, limit: 1 })).toMatchObject({
      target: { id: hop.id },
      total: 3,
      reachableCount: 4,
      possibleEndingCount: 1,
      nextOffset: 1,
      truncated: true,
      entries: [
        {
          nodeId: hop.id,
          entryId: 'impact_gain',
          writes: ['variable:impact_flag'],
        },
      ],
    });
    expect(inspect({ choiceId: choice.id, offset: 1, limit: 1 })).toMatchObject({
      entries: [
        {
          nodeId: gate.id,
          entryId: conditional.id,
          reads: ['variable:impact_flag', `visited:${hop.id}`],
        },
      ],
    });
    expect(inspect({ choiceId: choice.id, offset: 2 })).toMatchObject({
      entries: [
        {
          nodeId: end.id,
          entryId: 'impact_reset',
          section: 'events',
          writes: ['variable:impact_flag'],
        },
      ],
      nextOffset: null,
    });
    expect(inspect({ choiceId: choice.id, section: 'routes', query: 'impact_end' })).toMatchObject({
      total: 1,
      entries: [{ id: end.id, distance: 2, viaNodeId: gate.id, viaChoiceId: conditional.id }],
    });
    expect(project).toEqual(before);
  });
  it('keeps story messages available for node events and rejects them on options', () => {
    const project = testProject();
    const context: ToolContext = {
      project,
      selectedIds: ['scene_intro'],
      activeChapterId: null,
      intents: [],
    };
    const registry = createEditorTools();
    const effect = { kind: 'showMessage', title: '线索', text: '先确认时间，再比较证词。' };
    expect(
      registry.execute(
        'edit_choice',
        JSON.stringify({
          action: 'add',
          nodeId: 'scene_intro',
          label: '核对时间',
          targetId: 'scene_alternate',
          effects: [effect],
        }),
        context,
      ).ok,
    ).toBe(false);
    expect(context.project.scenes[0].choices).toEqual(project.scenes[0].choices);
    expect(
      registry.execute(
        'edit_event',
        JSON.stringify({
          action: 'save',
          nodeId: 'scene_alternate',
          name: '提醒',
          trigger: 'time',
          atMs: 1000,
          once: true,
          effects: [effect],
        }),
        context,
      ).ok,
    ).toBe(true);
    expect(
      context.project.scenes.find((s) => s.id === 'scene_alternate')!.events.at(-1)!.effects,
    ).toEqual([effect]);
    expect(validateProject(context.project).filter((issue) => issue.severity === 'error')).toEqual(
      [],
    );
  });
  it('publishes structured capabilities and allows new tools without changing the loop', () => {
    const registry = createEditorTools();
    expect(registry.specs()).toHaveLength(35);
    for (const name of ['read_playback', 'read_timeline', 'read_production_shots'])
      expect(registry.specs().map((tool) => tool.name)).not.toContain(name);
    const story = registry.specs().find(({ name }) => name === 'read_story')!;
    expect(story.parameters.oneOf).toEqual(
      expect.arrayContaining(
        ['playback', 'timeline', 'shots', 'shot'].map((action) =>
          expect.objectContaining({
            properties: expect.objectContaining({
              action: expect.objectContaining({ const: action }),
            }),
          }),
        ),
      ),
    );
    expect(registry.specs().map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'edit_choice',
        'edit_chapter',
        'edit_game_data',
        'edit_world_setting',
        'generate_shot_image',
        'generate_production_audio',
      ]),
    );
    registry.register({
      name: 'future_feature',
      label: '未来功能',
      group: 'extension',
      mode: 'read',
      description: '扩展功能',
      schema: z.object({ value: z.string() }),
      execute: (_, a) => ({ ok: true, summary: a.value }),
    });
    expect(registry.specs().find((t) => t.name === 'future_feature')?.parameters).toMatchObject({
      type: 'object',
      required: ['value'],
    });
  });
  it('keeps the original safeguards for deletion through the combined editing tools', () => {
    const project = testProject();
    const node = project.scenes[0];
    const linkedChoice = node.choices[1];
    const linkedNode = project.scenes.find((scene) => scene.id === linkedChoice.targetId)!;
    const originalChapter = linkedNode.chapterId;
    linkedNode.chapterId = 'chapter_extra';
    project.chapters.push({ id: 'chapter_extra', title: '临时章节', startNodeId: linkedNode.id });
    const context: ToolContext = { project, selectedIds: [], activeChapterId: null, intents: [] };
    const registry = createEditorTools();
    const remove = (name: string, args: object) =>
      registry.execute(name, JSON.stringify({ action: 'delete', ...args }), context);

    expect(remove('edit_game_data', { kind: 'variable', id: 'courage' }).ok).toBe(false);
    expect(remove('edit_chapter', { chapterId: 'chapter_extra' }).ok).toBe(false);
    expect(
      remove('edit_chapter', { chapterId: 'chapter_extra', targetChapterId: originalChapter }).ok,
    ).toBe(true);
    expect(context.project.scenes.find((scene) => scene.id === linkedNode.id)?.chapterId).toBe(
      originalChapter,
    );
    expect(context.project.scenes[0].choices[1].targetId).toBe(linkedNode.id);
    expect(remove('edit_choice', { nodeId: node.id, choiceId: linkedChoice.id }).ok).toBe(true);
    expect(context.project.scenes[0].choices.some(({ id }) => id === linkedChoice.id)).toBe(false);
  });
  it('validates input and rolls back only the failed command', () => {
    const registry = createEditorTools();
    const project = testProject();
    const context: ToolContext = {
      project,
      selectedIds: ['scene_intro'],
      activeChapterId: null,
      intents: [],
    };
    const before = structuredClone(project);
    expect(
      registry.execute(
        'edit_scene',
        JSON.stringify({
          action: 'update',
          args: { nodeId: 'scene_intro', patch: { title: '改名', chapterId: 'missing' } },
        }),
        context,
      ).ok,
    ).toBe(false);
    expect(context.project).toEqual(before);
    expect(
      registry.execute(
        'edit_scene',
        JSON.stringify({
          action: 'update',
          args: { nodeId: 'scene_intro', patch: { title: '改名' } },
        }),
        context,
      ).ok,
    ).toBe(true);
    const changed = context.project.scenes.find((s) => s.id === 'scene_intro')!;
    expect(changed.title).toBe('改名');
    expect(changed.choices).toEqual(project.scenes.find((s) => s.id === 'scene_intro')!.choices);
    expect(registry.execute('unknown', '{}', context).ok).toBe(false);
    expect(registry.execute('edit_scene', '{broken', context).ok).toBe(false);
    expect(
      registry.execute(
        'edit_scene',
        '{"action":"update","args":{"__proto__":{},"nodeId":"scene_intro","patch":{}}}',
        context,
      ).ok,
    ).toBe(false);
  });
  it('batches node edits, returns stable IDs, and keeps successful edits when one operation fails', () => {
    const project = testProject();
    const context: ToolContext = { project, selectedIds: [], activeChapterId: null, intents: [] };
    const registry = createEditorTools();
    const batch = (operations: object[]) =>
      registry.execute('edit_scene', JSON.stringify({ action: 'batch', operations }), context);
    const created = batch([
      {
        action: 'create',
        kind: 'video',
        title: '批量开场',
        notes: '主角在暗室里摸到开关，灯亮后看清出口。',
        storyboardPages: [{ text: '灯亮了。', durationMs: '3000' }],
      },
      { action: 'update', nodeId: 'missing', patch: { title: '不可写入' } },
      { action: 'create', kind: 'ending', title: '批量结局', notes: '收束暗室里的发现。' },
    ]);
    expect(created.ok).toBe(true);
    expect(created.data).toMatchObject({
      results: [
        { index: 0, ok: true, nodeIds: [expect.any(String)] },
        { index: 1, ok: false },
        { index: 2, ok: true, nodeIds: [expect.any(String)] },
      ],
    });
    const [fromId, toId] = created.nodeIds!;
    expect(
      batch([
        { action: 'update', nodeId: fromId, patch: { title: '新开场' } },
        { action: 'connect', fromId, toId },
      ]).ok,
    ).toBe(true);
    expect(context.project.scenes.find(({ id }) => id === fromId)).toMatchObject({
      title: '新开场',
      nextId: toId,
      storyboardPages: [{ text: '灯亮了。', durationMs: 3000 }],
    });
  });
  it('pages through chapter topology with actionable choice IDs and without full storyboard text', () => {
    const project = testProject();
    const node = project.scenes.find(({ id }) => id === 'scene_intro')!;
    node.storyboardPages = [{ text: '独立故事板正文', durationMs: 3000 }];
    const context: ToolContext = { project, selectedIds: [], activeChapterId: null, intents: [] };
    const registry = createEditorTools();
    const result = registry.execute(
      'read_story',
      JSON.stringify({
        action: 'topology',
        chapterId: node.chapterId,
        limit: 1,
        offset: project.scenes.filter((scene) => scene.chapterId === node.chapterId).indexOf(node),
      }),
      context,
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      nodes: [
        {
          id: node.id,
          pages: 1,
          choices: node.choices.map(({ id, label, targetId }) => ({ id, label, targetId })),
        },
      ],
      chapters: [{ id: node.chapterId, startNodeId: expect.any(String) }],
    });
    expect(JSON.stringify(result.data)).not.toContain('独立故事板正文');
  });

  it('moves the complete captured selection and preserves chapter entries', () => {
    const project = testProject();
    project.chapters.push({ id: 'chapter_two', title: '第二章', startNodeId: '' });
    const context: ToolContext = {
      project,
      selectedIds: project.scenes.slice(0, 2).map((s) => s.id),
      activeChapterId: null,
      intents: [],
    };
    const result = createEditorTools().execute(
      'edit_scene',
      '{"action":"move","args":{"chapterId":"chapter_two"}}',
      context,
    );
    expect(result.ok).toBe(true);
    expect(context.project.scenes.slice(0, 2).every((s) => s.chapterId === 'chapter_two')).toBe(
      true,
    );
    expect(context.project.chapters[1].startNodeId).toBe(context.selectedIds[0]);
  });
});

describe('ending follow-ups', () => {
  it('reuses ending IDs and prior lookup facts across three turns and drops stale facts', async () => {
    const { options, project, commit } = setup(async () => frame([], 'unused'));
    const ending = project.scenes.find((scene) => scene.kind === 'ending')!;
    const endingIds = ['test_ending_a', 'test_ending_b', 'test_ending_c'];
    project.scenes = [
      ...project.scenes.filter((scene) => scene.kind !== 'ending'),
      ...endingIds.map((id, index) => ({
        ...ending,
        id,
        title: `结果 ${index}`,
        endingText: `结局文案 ${index}`,
      })),
    ];
    const request = (action: string, args: object) => ({
      name: 'read_story',
      args: { action, args },
    });
    const first = await runAgent({
      ...options,
      user: '这个游戏有多少个结局',
      intent: { action: 'start', policy: { mode: 'discuss', target: { stage: 'outline' } } },
      client: async ({ exchanges }) => {
        if (!exchanges.length) return frame([request('list', { kind: 'ending' })]);
        expect(exchanges[0].replies[0].result.data).toMatchObject({
          total: 3,
          nodes: endingIds.map((id) => ({ id, kind: 'ending' })),
        });
        return frame([], '共有三个结局。');
      },
    });
    const chapterId = ending.chapterId;
    const second = await runAgent({
      ...options,
      session: sessionSchema.parse(first.session),
      user: '怎么打成不同结局的条件是什么',
      intent: { action: 'start', policy: { mode: 'discuss', target: { stage: 'outline' } } },
      client: async ({ system, exchanges }) => {
        for (const id of endingIds) expect(system).toContain(id);
        expect(system).toContain('"sameSnapshot":true');
        expect(system).toContain('"total":3');
        return exchanges.length
          ? frame([], '根据章节出口和选项判断路线。')
          : frame([request('list', { chapterId })]);
      },
    });
    const third = await runAgent({
      ...options,
      session: second.session,
      user: '三个结局的故事结果都是什么',
      intent: { action: 'start', policy: { mode: 'discuss', target: { stage: 'outline' } } },
      client: async ({ system, exchanges }) => {
        for (const id of endingIds) expect(system).toContain(id);
        expect(system).toContain('"sameSnapshot":true');
        if (!exchanges.length)
          return frame([
            {
              name: 'read_batch',
              args: {
                requests: endingIds.map((nodeId) => ({
                  tool: 'read_story',
                  args: request('read', { nodeId }).args,
                })),
              },
            },
          ]);
        expect(exchanges[0].replies[0].result.data).toMatchObject({
          results: endingIds.map((id, i) => ({ data: { id, endingText: `结局文案 ${i}` } })),
        });
        return frame([], '三个结局的故事结果如下。');
      },
    });
    expect(third.turn.status).toBe('completed');
    expect(third.turn.traces.map((trace) => trace.name)).toEqual(['read_batch']);
    expect(commit).not.toHaveBeenCalled();
    const same = buildContext(
      third.session,
      { ...options, intents: [] },
      '复述结局文案',
      [],
      undefined,
      third.turn.context?.projectDigest,
    );
    expect(same.system).toContain('结局文案 1');
    const changed = structuredClone(project);
    changed.scenes = changed.scenes.filter((scene) => scene.id !== endingIds[1]);
    const stale = await runAgent({
      ...options,
      project: changed,
      session: third.session,
      user: '现在呢',
      intent: { action: 'start', policy: { mode: 'discuss', target: { stage: 'outline' } } },
      client: async ({ system }) => {
        expect(system).not.toContain('结局文案 1');
        expect(system).not.toContain(endingIds[1]);
        expect(system).toContain('"sameSnapshot":false');
        return frame([], '需要按当前工程核实。');
      },
    });
    expect(stale.turn.status).toBe('completed');
  });
});
describe('agent harness', () => {
  it('keeps room for a valid batch after consecutive tool argument errors', async () => {
    const create = (name: string, action = 'create') => ({
      name: 'edit_game_data',
      args: { action, kind: 'variable', name, type: 'number', initial: 0 },
    });
    let round = 0;
    const { options, commit } = setup(async ({ system, exchanges }) => {
      if (++round < 3) return frame([create('测试好感度', 'unknown')]);
      if (round === 3) {
        expect(exchanges.at(-1)?.replies[0].result.ok).toBe(false);
        expect(system).toContain('最多发 20 次');
        return frame(
          ['测试好感度', '测试信任', '测试心跳', '测试勇气'].map((name) => create(name)),
        );
      }
      return frame([], '已创建四项属性。');
    });
    const { turn } = await runAgent(options);
    expect(turn.status, turn.error).toBe('completed');
    expect(turn.traces.slice(2).map((trace) => trace.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
    expect(commit.mock.calls[0][1].variables.map((row) => row.name)).toEqual(
      expect.arrayContaining(['测试好感度', '测试信任', '测试心跳', '测试勇气']),
    );
  });

  it('can list the active turn’s completed calls and serialize the replies and journal', async () => {
    let turnId = '';
    let round = 0;
    const history = (section: 'tools' | 'tool_result', offset = 0, traceIndex?: number) => ({
      action: 'read',
      args: { turnId, section, offset, traceIndex },
    });
    const { options } = setup(async ({ exchanges }) => {
      if (++round === 1)
        return frame([
          { name: 'read_project', args: {} },
          { name: 'read_project', args: { action: 'assets' } },
          { name: 'read_conversation', args: history('tools') },
        ]);
      if (round === 2) {
        const result = exchanges[0].replies[2].result;
        expect(result.ok).toBe(true);
        expect(JSON.parse(JSON.stringify(result.data))).toMatchObject({
          total: 2,
          nextOffset: null,
          traces: [{ name: 'read_project' }, { name: 'read_project' }],
        });
        return frame([
          {
            name: 'read_batch',
            args: {
              requests: [
                { tool: 'read_conversation', args: history('tools', 3) },
                { tool: 'read_conversation', args: history('tool_result', 0, 2) },
              ],
            },
          },
        ]);
      }
      const result = exchanges[1].replies[0].result;
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({
        results: [
          { ok: true, data: { total: 3, nextOffset: null, traces: [] } },
          { ok: true, data: { text: expect.stringContaining('read_conversation') } },
        ],
      });
      return frame([], '已读取本轮记录。');
    });
    options.onEvent = (event) => {
      if (event.type !== 'turn') return;
      turnId = event.turn.id;
      JSON.stringify(event.turn);
    };
    const { session, turn } = await runAgent(options);
    expect(turn.status, turn.error).toBe('completed');
    expect(sessionSchema.parse(JSON.parse(JSON.stringify(session))).turns[0].traces).toHaveLength(
      4,
    );
  });

  it('returns a large read batch to a running Codex thread even with a large prior provider frame', async () => {
    const { options, project } = setup(vi.fn());
    const note = {
      tool: 'read_story',
      args: {
        action: 'read',
        nodeId: project.scenes[0].id,
        section: 'notes',
      },
    };
    project.scenes[0].notes = 'a'.repeat(4000);
    const calls = frame([{ name: 'read_batch', args: { requests: Array(7).fill(note) } }]);
    const client = vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce({ ...calls, raw: { prior: 'x'.repeat(180_000) } })
      .mockImplementationOnce(async ({ exchanges }) => {
        expect(exchanges).toHaveLength(1);
        const result = exchanges[0].replies[0].result;
        expect(JSON.stringify(result).length).toBeGreaterThan(16_000);
        expect(result.data).toMatchObject({ nextOffset: 4 });
        return frame([], '审查完成。');
      });
    const { turn } = await runAgent({ ...options, provider: 'codex', client });
    expect(turn.status, turn.error).toBe('completed');
  });

  it('keeps unchanged storyboard reads and current links when the exchange budget is exhausted', async () => {
    const read = { action: 'read', nodeId: 'scene_intro', section: 'storyboard' };
    const { options, project } = setup(vi.fn());
    const node = project.scenes.find(({ id }) => id === read.nodeId)!;
    node.storyboardPages = [{ text: '保留这段故事板。', durationMs: 3000 }];
    const client = vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce({
        ...frame([
          { name: 'read_story', args: read },
          {
            name: 'edit_scene',
            args: { action: 'update', nodeId: read.nodeId, patch: { durationMs: 4000 } },
          },
        ]),
        raw: { largeProviderFrame: 'x'.repeat(200_000) },
      })
      .mockImplementationOnce(async ({ messages }) => {
        const current = messages.at(-1)?.content ?? '';
        expect(current).toContain('stillCurrentReads');
        expect(current).toContain('保留这段故事板。');
        expect(current).toContain('"topology"');
        expect(current).toContain(read.nodeId);
        return frame([], '已更新。');
      });
    const { turn } = await runAgent({ ...options, client });
    expect(turn.committed, turn.error).toBe(true);

    const trace = turn.traces[0];
    expect(trace.name).toBe('read_story');
    const moved = structuredClone(project);
    moved.layout[read.nodeId] = { x: 42, y: 42 };
    expect(workingReads([{ trace, project }], moved)).toHaveLength(1);
    moved.scenes.find(({ id }) => id === read.nodeId)!.storyboardPages = [
      { text: '更新后的正文', durationMs: 3000 },
    ];
    expect(workingReads([{ trace, project }], moved)).toHaveLength(0);
  });

  it('carries more than 9,600 characters of docs and settings across compaction and reuses covered ranges', async () => {
    const { options, project } = setup(vi.fn());
    const target = { stage: 'outline' } as const;
    const brief = { stage: 'brief' } as const;
    const outlineText = '旧公寓里有证物。'.repeat(700);
    const briefText = '病房外有脚步。'.repeat(770);
    project.storyDesign = {
      outline: { text: outlineText, version: crypto.randomUUID(), confirmed: false },
      brief: { text: briefText, version: crypto.randomUUID(), confirmed: false },
      chapters: [],
    };
    project.worldSettings = [{ id: 'location_case', kind: 'location', name: '旧公寓设定' }];
    const read = (args: object) => ({ name: 'read_story_design', args });
    const settings = { action: 'list', kind: 'location', limit: 20 };
    const client = vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce(
        frame([
          read({ target, limit: 2500 }),
          read({ target, offset: 2500, limit: 1000 }),
          read({ target, offset: 2000, limit: 2500 }),
          read({ target: brief }),
          { name: 'read_world_settings', args: settings },
        ]),
      )
      .mockImplementationOnce(async () => ({
        ...frame([{ name: 'check_story', args: { action: 'validate' } }]),
        raw: { largeProviderFrame: 'x'.repeat(200_000) },
      }))
      .mockImplementationOnce(async ({ messages }) => {
        const content = messages.at(-1)!.content;
        expect(content).toContain('stillCurrentReads');
        expect(content).toContain(briefText);
        expect(content).toContain(outlineText.slice(3500, 4500));
        expect(content).toContain('旧公寓设定');
        return frame([
          read({ target, offset: 1000, limit: 3000, source: 'project' }),
          read({ target, offset: 4000, limit: 1000 }),
          {
            name: 'read_batch',
            args: {
              requests: [
                { tool: 'read_world_settings', args: { ...settings, limit: 5 } },
                { tool: 'read_story_design', args: { target: brief, limit: 100 } },
                { tool: 'read_story_design', args: { target, offset: 5000, limit: 100 } },
              ],
            },
          },
        ]);
      })
      .mockImplementationOnce(async ({ exchanges }) => {
        const [duplicate, partial, batch] = exchanges.at(-1)!.replies;
        expect(duplicate.result.data).toEqual({ reused: true, nextOffset: 4500 });
        expect(partial.result.data).toMatchObject({
          offset: 4500,
          text: outlineText.slice(4500, 5000),
          nextOffset: 5000,
        });
        expect(batch.result.data).toMatchObject({
          results: [
            { index: 0, data: { reused: true } },
            { index: 1, data: { reused: true, nextOffset: null } },
            { index: 2, data: { offset: 5000, text: outlineText.slice(5000, 5100) } },
          ],
        });
        return frame([], '已复用材料。');
      });
    const { turn } = await runAgent({ ...options, client });
    expect(turn.status, turn.error).toBe('completed');
    expect(turn.execution?.contextCompactions).toBeGreaterThan(0);

    const updated = structuredClone(project);
    updated.storyDesign!.outline!.text = '改写后的大纲';
    updated.storyDesign!.outline!.version = crypto.randomUUID();
    const retained = workingReads(
      turn.traces.map((trace) => ({ trace, project })),
      updated,
    );
    expect(
      retained.some(
        (entry) =>
          entry.data.target && entry.data.version === project.storyDesign!.outline!.version,
      ),
    ).toBe(false);
    expect(retained.some((entry) => entry.tool === 'read_world_settings')).toBe(true);
  });

  it('makes room for the full outline before replaying old dialogue after compaction', async () => {
    const { options, project } = setup(vi.fn());
    const target = { stage: 'outline' } as const;
    const outline = '关键场戏。'.repeat(1150);
    project.storyDesign = {
      outline: { text: outline, version: crypto.randomUUID(), confirmed: true },
      chapters: [],
    };
    options.session.memory.summary = '旧创作记忆。'.repeat(1000);
    options.session.turns.push({
      id: 'old-turn',
      user: '旧讨论',
      assistant: '旧讨论的细节。'.repeat(1000),
      createdAt: new Date().toISOString(),
      status: 'completed',
      provider: 'deepseek',
      model: options.model,
      traces: [],
      committed: false,
      changedNodeIds: [],
    });
    const read = { name: 'read_story_design', args: { target, limit: 12_000 } };
    const client = vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce(frame([read]))
      .mockImplementationOnce(async ({ exchanges }) => {
        expect(exchanges.at(-1)?.replies[0].result.data).toMatchObject({ text: outline });
        return {
          ...frame([{ name: 'check_story', args: { action: 'validate' } }]),
          raw: { data: 'x'.repeat(200_000) },
        };
      })
      .mockImplementationOnce(async ({ messages }) => {
        expect(messages.at(-1)?.content).toContain(outline);
        return frame([read]);
      })
      .mockImplementationOnce(async ({ exchanges }) => {
        expect(exchanges.at(-1)?.replies[0].result.data).toEqual({
          reused: true,
          nextOffset: null,
        });
        return frame([], '已按大纲处理。');
      });
    const { turn } = await runAgent({ ...options, client });
    expect(turn.status, turn.error).toBe('completed');
    expect(turn.execution?.contextCompactions).toBeGreaterThan(0);
  });

  it('pages long author text inside a tight batch budget without losing characters', () => {
    const { options, project } = setup(vi.fn());
    const target = { stage: 'outline' };
    const text = '「对白」\\\n🔍'.repeat(1300);
    project.storyDesign = {
      outline: { text, version: crypto.randomUUID(), confirmed: false },
      chapters: [],
    };
    const context: ToolContext = {
      project,
      selectedIds: [],
      activeChapterId: null,
      intents: [],
      readPageCharacters: 1600,
    };
    const read = (offset: number) => ({ target, offset, limit: 12_000 });
    const first = options.registry.execute(
      'read_batch',
      JSON.stringify({
        requests: [
          { tool: 'read_story_design', args: read(0) },
          { tool: 'read_story_design', args: { target: { stage: 'brief' } } },
        ],
      }),
      context,
    );
    expect(first.data).toMatchObject({
      truncatedItems: [],
      results: [{ data: { offset: 0, total: text.length, nextOffset: expect.any(Number) } }],
    });
    type Page = { text: string; nextOffset: number | null };
    let page = (first.data as { results: { data: Page }[] }).results[0].data;
    let combined = page.text;
    while (page.nextOffset !== null) {
      const offset = page.nextOffset;
      page = options.registry.execute('read_story_design', JSON.stringify(read(offset)), context)
        .data as Page;
      expect(page.text.length).toBeGreaterThan(0);
      expect(page.text).not.toMatch(/[\uD800-\uDBFF]$/);
      combined += page.text;
    }
    expect(combined).toBe(text);
  });

  it('carries a full story overview through compaction and proceeds directly to a write', async () => {
    const { options, project } = setup(vi.fn());
    const node = project.scenes[0];
    const previousText = '铜纹从我的手腕延伸到手肘。';
    node.storyboardPages = [{ text: previousText, durationMs: 4000 }];
    const overview = { name: 'read_story', args: { action: 'overview' } };
    const client = vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce(frame([overview]))
      .mockResolvedValueOnce({
        ...frame([{ name: 'read_project', args: {} }]),
        raw: { providerFrame: 'x'.repeat(200_000) },
      })
      .mockImplementationOnce(async ({ system, exchanges }) => {
        expect(exchanges).toHaveLength(0);
        expect(system).toContain(previousText);
        expect(system).toContain(`"totalNodes":${project.scenes.length}`);
        return frame([overview]);
      })
      .mockImplementationOnce(async ({ exchanges }) => {
        expect(exchanges.at(-1)?.replies[0].result).toMatchObject({
          summary: expect.stringContaining('相同查询已返回'),
          data: { nextOffset: null },
        });
        return frame([
          {
            name: 'edit_scene',
            args: {
              action: 'update',
              nodeId: node.id,
              patch: { storyboardPages: [{ text: '新正文' }] },
            },
          },
        ]);
      })
      .mockImplementationOnce(async ({ system }) => {
        expect(system).not.toContain(previousText);
        return frame([], '已更新。');
      });
    const { turn } = await runAgent({ ...options, client });
    expect(turn.committed, turn.error).toBe(true);
    expect(turn.execution?.contextCompactions).toBe(1);
  });

  it('reuses an identical story read and returns fresh data after an edit', async () => {
    const { options } = setup(vi.fn());
    const nodeId = 'scene_intro';
    const read = { name: 'read_story', args: { action: 'read', nodeId, section: 'storyboard' } };
    const client = vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce(frame([read]))
      .mockResolvedValueOnce(frame([{ ...read, args: { ...read.args, offset: 0, limit: 15 } }]))
      .mockImplementationOnce(async ({ exchanges }) => {
        expect(exchanges.at(-1)?.replies[0].result).toEqual({
          ok: true,
          summary: expect.stringContaining('相同查询已返回'),
          data: { nextOffset: null },
        });
        return frame([
          {
            name: 'edit_scene',
            args: { action: 'update', nodeId, patch: { storyboardPages: [{ text: '新正文' }] } },
          },
          read,
        ]);
      })
      .mockImplementationOnce(async ({ exchanges }) => {
        expect(exchanges.at(-1)?.replies[1].result.data).toMatchObject({
          pages: [{ text: '新正文' }],
        });
        return frame([], '已更新。');
      });
    const { turn } = await runAgent({ ...options, client });
    expect(turn.committed, turn.error).toBe(true);
  });

  it('ends a loop that only rereads unchanged chapter links', async () => {
    const { options } = setup(vi.fn());
    const client = vi.fn<HarnessOptions['client']>(async () =>
      frame([{ name: 'read_story', args: { action: 'topology' } }]),
    );
    const { turn } = await runAgent({ ...options, client });
    expect(turn.error).toContain('连续三轮只重复读取');
    expect(client).toHaveBeenCalledTimes(3);
  });

  it('reuses chapter links after changing text and refreshes them after reconnecting a node', async () => {
    const { options, project } = setup(vi.fn());
    const node = project.scenes[0];
    const target = project.scenes[1];
    const leaf = project.scenes.find(({ kind }) => kind === 'ending')!;
    node.nextId = '';
    node.storyboardPages = [{ text: '原文', durationMs: 4000 }];
    const topology = {
      name: 'read_story',
      args: { action: 'topology', chapterId: node.chapterId },
    };
    const client = vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce(frame([topology]))
      .mockResolvedValueOnce(
        frame([
          {
            name: 'edit_scene',
            args: {
              action: 'update',
              nodeId: node.id,
              patch: { storyboardPages: [{ text: '新正文' }] },
            },
          },
          topology,
        ]),
      )
      .mockImplementationOnce(async ({ exchanges }) => {
        expect(exchanges.at(-1)?.replies[1].result.summary).toContain('相同查询已返回');
        return frame([
          { name: 'edit_scene', args: { action: 'connect', fromId: target.id, toId: leaf.id } },
          topology,
        ]);
      })
      .mockImplementationOnce(async ({ exchanges }) => {
        expect(exchanges.at(-1)?.replies[1].result.data).toMatchObject({
          nodes: expect.arrayContaining([
            expect.objectContaining({ id: target.id, nextId: leaf.id }),
          ]),
        });
        return frame([], '已更新。');
      });
    const { turn } = await runAgent({ ...options, client });
    expect(turn.committed, turn.error).toBe(true);
  });

  it('retains the newest complete exchange when older context fills the budget', async () => {
    const { options } = setup(vi.fn());
    const read = frame([{ name: 'read_project', args: {} }]);
    const latest = frame([{ name: 'read_story', args: { action: 'topology' } }]);
    // The first exchange fits alone. The two combined cross the budget.
    read.raw = { marker: 'a'.repeat(130_000) };
    latest.raw = { marker: 'b'.repeat(5500) };
    const client = vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce(read)
      .mockResolvedValueOnce(latest)
      .mockImplementationOnce(async ({ exchanges }) => {
        expect(exchanges).toHaveLength(1);
        expect(exchanges[0].frame.raw).toEqual(latest.raw);
        expect(exchanges[0].replies[0].call.name).toBe('read_story');
        expect(exchanges[0].replies[0].result.ok).toBe(true);
        return frame([], '已读取。');
      });
    const { turn } = await runAgent({ ...options, client });
    expect(turn.status, turn.error).toBe('completed');
    expect(turn.execution?.contextCompactions).toBe(1);
  });

  it('continues the same draft automatically when tool exchanges approach the budget', async () => {
    let round = 0;
    let oldToolResult = '';
    const { options, commit } = setup(async (request) => {
      round++;
      if (round === 1) {
        return {
          ...frame([
            {
              name: 'edit_game_data',
              args: { kind: 'item', name: '已保存的线索', description: '', initial: 0 },
            },
          ]),
          raw: { completeProviderFrame: 'a'.repeat(200_000) },
        };
      }
      if (round === 2) {
        expect(request.exchanges).toHaveLength(0);
        const context = request.messages.at(-1)?.content ?? '';
        expect(context).toContain(options.user);
        expect(context).toContain('已保存的线索');
        const turnId = context.match(/"turnId":"([^"]+)"/)?.[1];
        expect(turnId).toBeTruthy();
        return frame([
          {
            name: 'read_conversation',
            args: { action: 'read', args: { turnId, section: 'tool_result', traceIndex: 0 } },
          },
          {
            name: 'edit_game_data',
            args: { kind: 'item', name: '续写的线索', description: '', initial: 0 },
          },
        ]);
      }
      const trace = request.exchanges[0].replies[0].result;
      expect(trace.ok).toBe(true);
      oldToolResult = JSON.stringify(trace.data);
      return frame([], '已完成两条线索。');
    });
    const save = vi.fn(async () => {});
    options.saveCheckpoint = save;
    const result = await runAgent(options);
    expect(result.turn.status, result.turn.error).toBe('completed');
    expect(oldToolResult).toContain('已保存的线索');
    expect(result.turn.traces).toHaveLength(3);
    expect(result.turn.outcome).toBe('completed');
    expect(result.session.checkpoint).toBeUndefined();
    expect(save).toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][1].items.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['已保存的线索', '续写的线索']),
    );
  });

  it('finishes a Gemini 4 Argon turn with paginated reads and preserves native frames', async () => {
    const reads: { name: string; args: object }[] = [];
    const signature = 'A'.repeat(2_000);
    let round = 0;
    const { options, project, commit } = setup(async (request) => {
      if (round < reads.length) {
        return {
          ...frame([reads[round++]]),
          raw: { role: 'model', parts: [{ thoughtSignature: signature }] },
        };
      }
      expect(request.exchanges).toHaveLength(reads.length);
      expect(request.exchanges[0].frame.raw).toEqual({
        role: 'model',
        parts: [{ thoughtSignature: signature }],
      });
      return frame([], '已根据后续引用回答。');
    });
    options.provider = 'gemini';
    options.model = 'gemini-4-argon';
    options.user = '这个选项后续的影响是什么';
    options.intent = { action: 'start', policy: { mode: 'discuss', target: { stage: 'outline' } } };
    while (project.scenes.length < 154) {
      const scene = makeScene('video', project.scenes.length, project.chapters[0].id);
      project.scenes.push(scene);
    }
    reads.push(
      ...project.scenes
        .slice(0, 3)
        .map(({ id }) => ({ name: 'read_story', args: { action: 'read', args: { nodeId: id } } })),
    );
    reads.push(
      ...[0, 50, 100, 150].map((offset) => ({
        name: 'read_story',
        args: { action: 'list', args: { offset, limit: 50 } },
      })),
    );
    reads.push(
      ...project.scenes.slice(3, 8).map(({ id }) => ({
        name: 'read_story',
        args: { action: 'read', args: { nodeId: id, section: 'choices' } },
      })),
    );
    const result = await runAgent(options);
    expect(result.turn.status).toBe('completed');
    expect(result.turn.traces).toHaveLength(12);
    expect(commit).not.toHaveBeenCalled();
  });
  it('continues Gemini edits in smaller batches after a stalled response without replaying accepted writes', async () => {
    const add = (name: string) => ({
      name: 'edit_game_data',
      args: { kind: 'variable', name, type: 'number', initial: 0 },
    });
    const client = vi
      .fn<HarnessOptions['client']>()
      .mockImplementationOnce(async ({ maxOutputTokens, system }) => {
        expect(maxOutputTokens).toBeLessThan(40_960);
        expect(system).toContain('最多发 4 次');
        return frame([add('第一批')]);
      })
      .mockResolvedValueOnce({
        ...frame([add('不应写入')]),
        raw: null,
        finish: 'invalid',
        issue: 'Gemini 响应停顿超过 180 秒。',
      })
      .mockImplementationOnce(async ({ exchanges, system }) => {
        expect(exchanges).toHaveLength(1);
        expect(exchanges[0].replies[0].result.ok).toBe(true);
        expect(system).toContain('最多发 2 次');
        expect(system).toContain('上次响应未执行');
        return frame([add('第二批')]);
      })
      .mockResolvedValueOnce(frame([], '已完成两批编辑。'));
    const { options, commit } = setup(client);
    const { turn } = await runAgent({ ...options, provider: 'gemini' });
    expect(turn.status, turn.error).toBe('completed');
    expect(turn.execution?.rejectedResponses).toBe(1);
    expect(commit).toHaveBeenCalledOnce();
    const names = commit.mock.calls[0][1].variables.map(({ name }) => name);
    expect(names.filter((name) => name === '第一批' || name === '第二批')).toEqual([
      '第一批',
      '第二批',
    ]);
    expect(names).not.toContain('不应写入');
  });
  it('makes progress when a complete Gemini response exceeds the adaptive tool allowance', async () => {
    const rows = ['甲', '乙', '丙', '丁'].map((name) => ({
      name: 'edit_game_data',
      args: { kind: 'variable', name, type: 'number', initial: 0 },
    }));
    const overLimit = frame(rows);
    overLimit.raw = {
      role: 'model',
      parts: overLimit.calls.map(({ id, name }) => ({
        functionCall: { id, name },
        thoughtSignature: `signed-${id}`,
      })),
    };
    const client = vi
      .fn<HarnessOptions['client']>()
      .mockResolvedValueOnce({ ...frame(rows), finish: 'length' })
      .mockImplementationOnce(async ({ system }) => {
        expect(system).toContain('最多发 2 次');
        return overLimit;
      })
      .mockImplementationOnce(async ({ exchanges, system }) => {
        expect(system).toContain('2 个调用尚未执行');
        expect(exchanges[0].frame.raw).toEqual(overLimit.raw);
        expect(exchanges[0].replies.map(({ call, result }) => [call.id, result.ok])).toEqual(
          overLimit.calls.map(({ id }, index) => [id, index < 2]),
        );
        return frame(rows.slice(2));
      })
      .mockResolvedValueOnce(frame([], '四项均已写入。'));
    const { options, commit } = setup(client);
    const { turn } = await runAgent({ ...options, provider: 'gemini' });
    expect(turn.status, turn.error).toBe('completed');
    expect(turn.execution?.rejectedResponses).toBe(1);
    expect(turn.traces).toHaveLength(4);
    expect(commit.mock.lastCall![1].variables.slice(-4).map(({ name }) => name)).toEqual([
      '甲',
      '乙',
      '丙',
      '丁',
    ]);
  });
  it('completes a multi-step key branch, validates, and commits exactly once', async () => {
    let round = 0;
    const { options, commit } = setup(async (request) => {
      if (round++ === 0) {
        expect(request.system).toContain('scene_intro');
        return frame([
          {
            name: 'edit_game_data',
            args: { kind: 'item', name: '铜钥匙', description: '开门', initial: 1 },
          },
          {
            name: 'edit_scene',
            args: {
              action: 'create',
              args: {
                kind: 'video',
                title: '门后',
                notes: '主角推门，踏入下一处空间。',
                storyboardPages: [{ text: '你打开了门。' }],
              },
            },
          },
        ]);
      }
      if (round === 2) {
        const results = request.exchanges[0].replies;
        const item = results[0].result.data as { id: string };
        const target = results[1].result.data as { nodeId: string };
        return frame([
          {
            name: 'edit_choice',
            args: {
              action: 'add',
              nodeId: 'scene_intro',
              label: '用钥匙开门',
              targetId: target.nodeId,
              conditionJson: JSON.stringify({ kind: 'item', itemId: item.id, op: 'gte', count: 1 }),
            },
          },
          {
            name: 'edit_event',
            args: {
              action: 'save',
              nodeId: target.nodeId,
              name: '使用钥匙',
              trigger: 'complete',
              once: false,
              atMs: 0,
              effects: [{ kind: 'removeItem', itemId: item.id, count: 1 }],
            },
          },
        ]);
      }
      expect(request.exchanges).toHaveLength(2);
      return frame([], '已添加钥匙分支，并配置条件与消耗。');
    });
    const result = await runAgent(options);
    expect(result.turn.status).toBe('completed');
    expect(result.turn.committed).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    const candidate = commit.mock.calls[0]![1];
    expect(validateProject(candidate).filter((v) => v.severity === 'error')).toEqual([]);
    expect(candidate.scenes.at(-1)?.events[0].effects[0].kind).toBe('removeItem');
    expect(result.session.turns).toHaveLength(1);
  });
  it('replays duplicate write calls idempotently', async () => {
    let i = 0;
    const call = {
      name: 'edit_scene',
      id: 'same',
      args: {
        action: 'create',
        args: {
          kind: 'video',
          title: '一次创建',
          notes: '主角抵达路口并停步。',
          storyboardPages: [{ text: '一次创建' }],
        },
      },
    };
    const { options, commit, project } = setup(async () =>
      i++ < 2 ? frame([call]) : frame([], '完成'),
    );
    const result = await runAgent(options);
    expect(result.turn.status).toBe('completed');
    expect(commit.mock.calls[0]![1].scenes).toHaveLength(project.scenes.length + 1);
  });
  it('continues a saved draft after eight edits without requiring a plan', async () => {
    const createScene = (index: number) => ({
      name: 'edit_scene',
      args: {
        action: 'create',
        kind: 'video',
        title: `剧情 ${index}`,
        notes: '主角来到新的调查地点。',
        storyboardPages: [{ text: '剧情' }],
      },
    });
    const { options, commit, project } = setup(
      vi
        .fn<HarnessOptions['client']>()
        .mockResolvedValueOnce(frame(Array.from({ length: 8 }, (_, index) => createScene(index))))
        .mockRejectedValueOnce(new Error('连接中断')),
    );
    const first = await runAgent(options);
    expect(first.session.checkpoint?.writes).toHaveLength(8);
    expect(commit).not.toHaveBeenCalled();
    const next = await runAgent({
      ...options,
      session: first.session,
      user: '继续',
      intent: { action: 'resume' },
      client: vi
        .fn<HarnessOptions['client']>()
        .mockResolvedValueOnce(frame([createScene(8)]))
        .mockResolvedValueOnce(frame([], '已完成')),
    });
    expect(next.turn.status).toBe('completed');
    expect(next.turn.editCount).toBe(9);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][1].scenes).toHaveLength(project.scenes.length + 9);
  });

  it('loads the saved chapter and outline before the first request when continuing', async () => {
    const { options, project, commit } = setup(vi.fn());
    const target = { stage: 'chapter', chapterId: project.chapters[0].id } as const;
    const outline = '大纲里的关键线索。'.repeat(630);
    const chapter = '上次已写入的场戏。'.repeat(880);
    project.storyDesign = {
      outline: { text: outline, version: crypto.randomUUID(), confirmed: true },
      chapters: [],
    };
    const first = await runAgent({
      ...options,
      intent: { action: 'start', policy: { mode: 'design', target } },
      client: vi
        .fn<HarnessOptions['client']>()
        .mockResolvedValueOnce(
          frame([{ name: 'edit_story_design', args: { target, text: chapter } }]),
        )
        .mockRejectedValueOnce(new Error('连接中断')),
    });
    expect(first.session.checkpoint?.draft.storyDesign?.chapters[0]?.text).toBe(chapter);
    const second = await runAgent({
      ...options,
      session: first.session,
      user: '继续',
      intent: { action: 'resume' },
      client: vi
        .fn<HarnessOptions['client']>()
        .mockImplementationOnce(async (request) => {
          expect(request.tools.some(({ name }) => name === 'set_task_scope')).toBe(false);
          expect(request.messages.at(-1)?.content).toContain(chapter);
          expect(request.messages.at(-1)?.content).toContain(outline);
          return frame([
            { name: 'read_story_design', args: { target, offset: 1, limit: 100 } },
            { name: 'read_story_design', args: { target, offset: chapter.length } },
          ]);
        })
        .mockImplementationOnce(async ({ exchanges }) => {
          for (const { result } of exchanges.at(-1)!.replies) {
            expect(result.summary).toContain('请复用已读内容');
            expect(result.data).toEqual({ reused: true, nextOffset: null });
          }
          return frame([], '已恢复章节草稿');
        }),
    });
    expect(second.turn.status, second.turn.error).toBe('completed');
    expect(commit.mock.calls[0][1].storyDesign?.chapters[0]?.text).toBe(chapter);
  });

  it('keeps the last saved checkpoint when a later checkpoint cannot be persisted', async () => {
    const { options, commit } = setup(
      vi.fn<HarnessOptions['client']>().mockResolvedValueOnce(
        frame([
          {
            name: 'edit_game_data',
            args: { kind: 'variable', name: '新计数', type: 'number', initial: 0 },
          },
        ]),
      ),
    );
    options.saveCheckpoint = vi
      .fn<NonNullable<HarnessOptions['saveCheckpoint']>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('写入失败'));
    const result = await runAgent(options);
    expect(result.turn.error).toContain('未能保存当前续跑检查点');
    expect(result.session.checkpoint?.draft.variables).toEqual(options.project.variables);
    expect(commit).not.toHaveBeenCalled();
  });
  it('reports rejected Gemini response batches without exposing or replaying their raw parts', () => {
    const calls = Array.from({ length: 21 }, () => ({ functionCall: { name: 'read_project' } }));
    expect(parseModelFrame('gemini', { candidates: [{ content: { parts: calls } }] })).toEqual({
      text: '',
      calls: [],
      raw: null,
      finish: 'invalid',
      issue: '模型一次返回了 21 次工具调用，上限为 20 次。',
    });
    expect(parseModelFrame('gemini', { candidates: [{ finishReason: 'MAX_TOKENS' }] }).finish).toBe(
      'length',
    );
    expect(
      parseModelFrame('gemini', { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] })
        .finish,
    ).toBe('invalid');
  });
  it('feeds invalid final projects back to the model, then rolls back on step limit', async () => {
    let i = 0;
    const { options, commit } = setup(async (request) => {
      if (i++ === 0)
        return frame([
          {
            name: 'edit_scene',
            args: {
              action: 'create',
              args: { kind: 'branch', title: '不完整分支', notes: '按证据状态决定出口。' },
            },
          },
        ]);
      if (request.exchanges.length > 1)
        expect(request.exchanges.at(-1)?.feedback).toContain('校验未通过');
      return frame([], '完成');
    });
    options.maxRounds = 3;
    const result = await runAgent(options);
    expect(result.turn.status).toBe('error');
    expect(result.turn.committed).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(result.turn.assistant).toContain('未提交');
  });
  it('stops without submitting staged changes and preserves an interrupted journal', async () => {
    const controller = new AbortController();
    let i = 0;
    const { options, commit } = setup(async () => {
      if (i++ === 0)
        return frame([
          {
            name: 'edit_scene',
            args: {
              action: 'create',
              args: { kind: 'ending', title: '不应落盘', notes: '回顾前一场行动的结果。' },
            },
          },
        ]);
      controller.abort();
      return frame([], '完成');
    });
    options.signal = controller.signal;
    const result = await runAgent(options);
    expect(result.turn.status).toBe('stopped');
    expect(result.session.turns[0].committed).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });
  it('detects stale project snapshots instead of overwriting manual edits', async () => {
    let i = 0;
    const { options, commit } = setup(async () =>
      i++
        ? frame([], '完成')
        : frame([
            {
              name: 'edit_scene',
              args: {
                action: 'update',
                args: { nodeId: 'scene_intro', patch: { title: 'Agent修改' } },
              },
            },
          ]),
    );
    commit.mockReturnValue(false);
    expect((await runAgent(options)).turn.status).toBe('conflict');
  });
  it('compacts completed history while retaining full retrievable source turns', async () => {
    const { options } = setup(async (request) =>
      request.tools.length
        ? frame([], '记得之前的约束。')
        : frame([], '用户希望悬疑故事，关键节点 scene_intro；之前修改已提交。'),
    );
    for (let i = 0; i < 12; i++)
      options.session.turns.push({
        id: `old_${i}`,
        user: '保留悬疑风格。'.repeat(400),
        assistant: '已经记录。'.repeat(400),
        status: 'completed',
        traces: [],
        committed: false,
        changedNodeIds: [],
        provider: 'deepseek',
        model: 'model',
        createdAt: new Date().toISOString(),
      });
    expect(planCompaction(options.session)).not.toBeNull();
    const result = await runAgent(options);
    expect(result.turn.status).toBe('completed');
    expect(result.session.memory.through).toBeGreaterThan(0);
    expect(result.session.turns).toHaveLength(13);
    const context: ToolContext = {
      project: options.project,
      selectedIds: [],
      activeChapterId: null,
      intents: [],
      history: result.session.turns,
    };
    expect(
      createEditorTools().execute(
        'read_conversation',
        '{"action":"read","args":{"turnId":"old_0","section":"messages"}}',
        context,
      ).ok,
    ).toBe(true);
  });
});
describe('editor host', () => {
  it('merges nested edits and keeps the user position when the draft arranges the same node', () => {
    const base = testProject();
    const current = structuredClone(base);
    const draft = structuredClone(base);
    const id = base.scenes[0].id;
    current.layout[id].x += 100;
    current.scenes[0].choices[0].label = '用户改过的选项';
    draft.layout[id].y += 100;
    draft.scenes[0].choices[0].lockedText = 'Agent 修改的提示';
    const scene = makeScene('ending', draft.scenes.length + 1, draft.chapters[0].id);
    draft.scenes.push(scene);
    draft.layout[scene.id] = { x: 900, y: 0 };
    const merged = mergeProjectEdits(base, current, draft);
    expect(merged).toMatchObject({
      project: {
        layout: { [id]: current.layout[id], [scene.id]: draft.layout[scene.id] },
      },
    });
    if ('error' in merged) throw new Error(merged.error);
    expect(merged.project.scenes[0].choices[0]).toMatchObject({
      label: '用户改过的选项',
      lockedText: 'Agent 修改的提示',
    });
    expect(merged.project.scenes.at(-1)?.id).toBe(scene.id);
  });

  it('reports a deleted node when the draft edits it', () => {
    const base = testProject();
    const current = structuredClone(base);
    const draft = structuredClone(base);
    const removed = current.scenes.pop()!;
    delete current.layout[removed.id];
    draft.scenes.at(-1)!.notes = 'Agent 补充的备注';
    expect(mergeProjectEdits(base, current, draft)).toMatchObject({
      error: expect.stringContaining(`scenes[${removed.id}]`),
    });
  });

  it('commits all tools as one undo step and rejects edit/undo ABA snapshots', () => {
    useEditor.getState().load(testProject());
    const base = useEditor.getState().project;
    const candidate = structuredClone(base);
    const serial = useEditor.getState().changeSerial;
    candidate.title = '新的标题';
    candidate.scenes[0].title = '新的节点';
    expect(commitAgentTransaction(base, candidate, [], serial)).toBe(true);
    expect(useEditor.getState().past).toHaveLength(1);
    useEditor.getState().undo();
    expect(useEditor.getState().project.title).toBe(base.title);
    useEditor.getState().patchScene(base.scenes[0].id, { title: '手动修改' });
    useEditor.getState().undo();
    expect(commitAgentTransaction(base, candidate, [], serial)).toBe(false);
  });
});
describe('model adapters', () => {
  const config = defaultAgentSettings().providers;
  const request: ModelRequest = {
    runId: 'run_test',
    provider: 'openai',
    system: 'system',
    messages: [{ role: 'user', content: 'test' }],
    tools: [],
    exchanges: [],
    maxOutputTokens: 4096,
  };
  it('preserves OpenAI encrypted reasoning and returns tool outputs by call_id', () => {
    const raw = [
      { type: 'reasoning', encrypted_content: 'opaque' },
      { type: 'function_call', call_id: 'c1', name: 'read_project', arguments: '{}' },
    ];
    const f = parseModelFrame('openai', { status: 'completed', output: raw });
    const wire = providerRequest('openai', config.openai, 'SECRET', {
      ...request,
      exchanges: [
        { frame: f, replies: [{ call: f.calls[0], result: { ok: true, summary: 'read' } }] },
      ],
    });
    const body = JSON.parse(wire.init.body);
    expect(body.input[1]).toEqual(raw[0]);
    expect(body.input.at(-1).call_id).toBe('c1');
    expect(body.include).toContain('reasoning.encrypted_content');
    expect(wire.url).not.toContain('SECRET');
  });
  it('preserves Gemini signatures and generates unique IDs when native calls omit them', () => {
    const raw = {
      role: 'model',
      parts: [{ thoughtSignature: 'signed', functionCall: { name: 'read_project', args: {} } }],
    };
    const a = parseModelFrame('gemini', { candidates: [{ content: raw }] });
    const b = parseModelFrame('gemini', { candidates: [{ content: raw }] });
    expect(a.calls[0].id).not.toBe(b.calls[0].id);
    const wire = providerRequest('gemini', config.gemini, 'SECRET', {
      ...request,
      exchanges: [
        { frame: a, replies: [{ call: a.calls[0], result: { ok: true, summary: 'read' } }] },
      ],
    });
    const body = JSON.parse(wire.init.body);
    expect(body.contents[1]).toEqual(raw);
    expect(body.contents[2].parts[0].functionResponse).toMatchObject({ name: 'read_project' });
    expect(body.generationConfig).toEqual({
      maxOutputTokens: request.maxOutputTokens,
      thinkingConfig: { thinkingLevel: 'MEDIUM' },
    });
    expect(wire.init.headers['x-goog-api-key']).toBe('SECRET');
  });
  it('preserves MiniMax reasoning only in opaque protocol history', () => {
    const raw = {
      role: 'assistant',
      content: null,
      reasoning_content: 'opaque-reasoning',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_project', arguments: '{}' } },
      ],
    };
    const f = parseModelFrame('minimax', {
      choices: [{ message: raw, finish_reason: 'tool_calls' }],
    });
    expect(f.text).toBe('');
    const wire = providerRequest('minimax', config.minimax, 'SECRET', {
      ...request,
      exchanges: [
        { frame: f, replies: [{ call: f.calls[0], result: { ok: true, summary: 'read' } }] },
      ],
    });
    expect(JSON.parse(wire.init.body).messages[2]).toEqual(raw);
  });
  it('does not display or run tool syntax leaked into MiniMax content', () => {
    const raw = {
      role: 'assistant',
      content: ']<]minimax[>[<tool_call> [read_story] [</tool_call>',
    };
    expect(parseModelFrame('minimax', { choices: [{ message: raw }] })).toMatchObject({
      finish: 'invalid',
      text: '',
      calls: [],
      raw: null,
    });
    const message = {
      ...raw,
      tool_calls: [{ id: 'c1', function: { name: 'read_project', arguments: '{}' } }],
    };
    expect(parseModelFrame('minimax', { choices: [{ message }] })).toMatchObject({
      finish: 'complete',
      text: '',
      calls: [{ name: 'read_project' }],
      raw: message,
    });
  });
  it('keeps current selection and fixed references separate from compressed history', () => {
    const project = testProject();
    const session = newSession(project.id);
    session.pinnedSceneIds = [project.scenes[1].id];
    const built = buildContext(
      session,
      { project, selectedIds: [project.scenes[0].id], activeChapterId: null, intents: [] },
      '修改这里',
      createEditorTools().specs(),
    );
    expect(built.stats.selectedSceneIds).toEqual([project.scenes[0].id]);
    expect(built.stats.pinnedSceneIds).toEqual(session.pinnedSceneIds);
    expect(built.stats.estimatedTokens).toBeLessThan(built.stats.budgetTokens);
  });
  it('gives the model the choice label limit in the prompt and both editing fields', () => {
    const project = testProject();
    const tools = createEditorTools().specs();
    const built = buildContext(
      newSession(project.id),
      { project, selectedIds: [], activeChapterId: null, intents: [] },
      '拟几个互动选项',
      tools,
    );
    expect(built.system).toContain('互动选项文案，每条最多 12 个字符');
    expect(built.system).toContain('超长就保留原意重写');
    const parameters = tools.find((tool) => tool.name === 'edit_choice')?.parameters;
    const limit = expect.stringContaining('最多 12 个字符');
    expect(parameters).toHaveProperty('oneOf.0.properties.label.description', limit);
    expect(parameters).toHaveProperty(
      'oneOf.1.properties.patch.properties.label.description',
      limit,
    );
  });
  it('ignores retired custom prompts in old sessions while retaining conversation context', () => {
    const project = testProject();
    const legacy = { ...newSession(project.id), instruction: 'RETIRED_CUSTOM_PROMPT' };
    legacy.pinnedSceneIds = ['scene_intro'];
    legacy.memory.summary = '保留正常历史记忆';
    const parsed = sessionSchema.parse(legacy);
    expect(parsed).not.toHaveProperty('instruction');
    const built = buildContext(
      legacy,
      { project, selectedIds: ['scene_intro'], activeChapterId: null, intents: [] },
      '保留普通对话输入',
      createEditorTools().specs(),
    );
    expect(built.system).not.toContain('RETIRED_CUSTOM_PROMPT');
    expect(built.system).not.toContain('创作偏好');
    expect(built.system).toContain('保留正常历史记忆');
    expect(built.messages.at(-1)?.content).toBe('保留普通对话输入');
    expect(built.stats.pinnedSceneIds).toEqual(['scene_intro']);
  });
});
