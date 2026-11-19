import { describe, expect, it } from 'vitest';
import { testProject } from '../fixtures/project';
import { parseProject } from '../../packages/domain/schema';
import {
  advance,
  choose,
  finish,
  fingerprint,
  loadGame,
  saveGame,
  start,
} from '../../packages/runtime/engine';
import { runtimeNoticesSince } from '../../packages/runtime/notifications';
import { createEditorTools } from '../../packages/agent/tools';
import type { ToolContext } from '../../packages/agent/types';

describe('hidden game attributes', () => {
  it('keeps old definitions visible and preserves explicit visibility through project parsing', () => {
    const project = testProject();
    expect(parseProject(project).variables.every((v) => !v.hidden)).toBe(true);
    project.variables[0].hidden = true;
    const parsed = parseProject(JSON.parse(JSON.stringify(project)));
    expect(parsed.variables[0].hidden).toBe(true);
    expect(() =>
      parseProject({ ...project, variables: [{ ...project.variables[0], hidden: 'true' }] }),
    ).toThrow();
  });
  it('keeps hidden attributes in rules and saves without leaking change notices or invalidating old saves', () => {
    const project = testProject();
    const before = advance(project, start(project), 6000);
    const saved = saveGame(project, before);
    const oldFingerprint = fingerprint(project);
    project.variables[0].hidden = true;
    expect(fingerprint(project)).toBe(oldFingerprint);
    const next = choose(project, loadGame(project, saved), 'choice_explore');
    expect(next.variables.trust).toBe(45);
    expect(
      runtimeNoticesSince(before, next).some((n) => n.kind === 'variable' && n.name === '信任'),
    ).toBe(false);
    expect(next.log.some((entry) => entry.message === '信任 → 45')).toBe(true);
    expect(loadGame(project, saveGame(project, next)).variables.trust).toBe(45);
    expect(finish(project, finish(project, next)).nodeId).toBe('scene_success');
    project.variables[0].hidden = false;
    expect(loadGame(project, saved).variables.trust).toBe(30);
    const visible = choose(project, before, 'choice_explore');
    expect(
      runtimeNoticesSince(before, visible).some((n) => n.kind === 'variable' && n.name === '信任'),
    ).toBe(true);
  });
  it('lets the Agent create, inspect and change visibility while preserving it when omitted', () => {
    const context: ToolContext = {
      project: testProject(),
      selectedIds: [],
      activeChapterId: null,
      intents: [],
    };
    const tools = createEditorTools();
    const invoke = (args: Record<string, unknown>) =>
      tools.execute('edit_game_data', JSON.stringify({ kind: 'variable', ...args }), context);
    expect(invoke({ name: '幕后线索', type: 'number', initial: 0, hidden: true }).ok).toBe(true);
    const variable = context.project.variables.find((v) => v.name === '幕后线索')!;
    expect(context.project.variables.find((v) => v.id === variable.id)?.hidden).toBe(true);
    expect(
      invoke({ id: variable.id, name: variable.name, type: variable.type, initial: 2 }).ok,
    ).toBe(true);
    expect(context.project.variables.find((v) => v.id === variable.id)?.hidden).toBe(true);
    const listed = tools.execute(
      'list_game_data',
      JSON.stringify({ kind: 'variable', query: variable.name }),
      context,
    );
    expect(JSON.stringify(listed.data)).toContain('"hidden":true');
    expect(
      invoke({
        id: variable.id,
        name: variable.name,
        type: variable.type,
        initial: 2,
        hidden: false,
      }).ok,
    ).toBe(true);
    expect(context.project.variables.find((v) => v.id === variable.id)?.hidden).toBe(false);
  });
});
