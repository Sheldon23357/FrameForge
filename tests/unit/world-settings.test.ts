import { expect, it } from 'vitest';
import { createEditorTools } from '../../packages/agent/tools';
import type { ToolContext } from '../../packages/agent/types';
import { makeProject, makeScene, parseProject } from '../../packages/domain/schema';
import { validateProject } from '../../packages/domain/validation';
import { prepareGameProject } from '../../packages/export/project';
import { fingerprint } from '../../packages/runtime/engine';
import { createWorldSetting } from '../../packages/domain/world-settings';

it('stores searchable setting records and links without changing playback or exporting the records', () => {
  const registry = createEditorTools();
  const project = makeProject();
  project.scenes.push(makeScene('ending', 2, project.chapters[0].id));
  const [start, end] = project.scenes;
  start.nextId = end.id;
  const before = fingerprint(parseProject(project));
  const { id: settingId } = createWorldSetting(project, 'character', {
    name: '林远',
    description: '车站管理员',
    visual: '灰色制服和铜钥匙',
    sound: '低声，语速慢',
  });
  const context: ToolContext = { project, selectedIds: [], activeChapterId: null, intents: [] };
  const edit = (args: unknown) =>
    registry.execute('edit_world_setting', JSON.stringify(args), context);
  const read = (args: unknown) =>
    registry.execute('read_world_settings', JSON.stringify(args), context);
  expect(edit({ action: 'create', kind: 'character', name: ' 林远 ' }).ok).toBe(false);
  expect(edit({ action: 'update', settingId, patch: { imageAssetId: 'missing' } }).ok).toBe(false);
  expect(
    edit({ action: 'update', settingId, patch: { description: '车站管理员，性格沉稳' } }).ok,
  ).toBe(true);
  expect(edit({ action: 'link', settingId, nodeIds: [start.id, 'missing'] }).ok).toBe(false);
  expect(context.project.scenes[0].settingIds).toBeUndefined();
  expect(edit({ action: 'link', settingId, nodeIds: [start.id, end.id, start.id] }).ok).toBe(true);
  expect(read({ action: 'list', query: '铜钥匙', nodeId: start.id }).data).toMatchObject({
    total: 1,
    settings: [{ id: settingId, name: '林远' }],
  });
  expect(read({ action: 'read', settingId, limit: 1 }).data).toMatchObject({
    total: 2,
    nextOffset: 1,
    setting: { sound: '低声，语速慢' },
    nodes: [{ id: start.id }],
  });
  const reopened = parseProject(JSON.parse(JSON.stringify(context.project)));
  expect(reopened.scenes[0].settingIds).toEqual([settingId]);
  expect(validateProject(reopened)).toEqual(validateProject(project));
  expect(fingerprint(reopened)).toBe(before);
  const game = prepareGameProject(reopened);
  expect(game.worldSettings).toBeUndefined();
  expect(game.scenes[0].settingIds).toBeUndefined();
  expect(fingerprint(parseProject(game))).toBe(before);
  expect(edit({ action: 'delete', settingId }).ok).toBe(true);
  expect(context.project.worldSettings).toEqual([]);
  expect(context.project.scenes.every((scene) => !scene.settingIds?.length)).toBe(true);
});

it('rejects short Agent-authored character descriptions and accepts both minimum lengths', () => {
  const registry = createEditorTools();
  const project = makeProject();
  const context: ToolContext = { project, selectedIds: [], activeChapterId: null, intents: [] };
  const edit = (args: unknown) =>
    registry.execute('edit_world_setting', JSON.stringify(args), context);
  const params = { action: 'create', kind: 'character', name: '林远' };
  const shortVisual = '深'.repeat(199) + '。！';
  const shortSound = '稳'.repeat(49) + '， 。';
  expect(edit({ ...params, visual: shortVisual, sound: shortSound })).toMatchObject({
    ok: false,
    summary: expect.stringMatching(
      /角色形象至少 200 字，目前 199 字.*角色声音描述至少 50 字，目前 49 字/,
    ),
  });
  expect(context.project.worldSettings).toBeUndefined();

  const visual = shortVisual + '灰';
  const sound = shortSound + '静';
  const created = edit({ ...params, visual, sound });
  expect(created.ok).toBe(true);
  const { settingId } = created.data as { settingId: string };
  expect(edit({ action: 'update', settingId, patch: { sound: '轻声' } }).ok).toBe(false);
  expect(context.project.worldSettings?.[0]).toMatchObject({ visual, sound });
  expect(edit({ action: 'update', settingId, patch: { sound: '' } }).ok).toBe(true);
  expect(
    edit({ action: 'create', kind: 'location', name: '站台', visual: '东侧有单扇铁门' }).ok,
  ).toBe(true);
});
