import { expect, it } from 'vitest';
import { createEditorTools } from '../../packages/agent/tools';
import { parseProject } from '../../packages/domain/schema';
import { prepareGameProject } from '../../packages/export/project';
import { testProject } from '../fixtures/project';

it('reads, partially updates, clears and excludes author defaults from game export', () => {
  const registry = createEditorTools();
  const context = { project: testProject(), selectedIds: [], activeChapterId: null, intents: [] };
  const edit = (creativeDefaults: object | null) =>
    registry.execute('update_project', JSON.stringify({ creativeDefaults }), context);
  expect(edit({ genre: '悬疑推理', tone: '克制冷峻', chapterCount: 5 }).ok).toBe(true);
  expect(edit({ chapterCount: 3, tone: null }).ok).toBe(true);
  expect(edit({ aspectRatio: '9:16' }).ok).toBe(false);
  expect(registry.execute('read_project', '{}', context).data).toMatchObject({
    settings: {
      creativeDefaults: { genre: '悬疑推理', chapterCount: 3 },
      width: 1920,
      height: 1080,
    },
  });
  expect(parseProject(context.project).settings.creativeDefaults).toEqual({
    genre: '悬疑推理',
    chapterCount: 3,
  });
  expect(prepareGameProject(context.project).settings.creativeDefaults).toBeUndefined();
  expect(edit(null).ok).toBe(true);
  expect(context.project.settings.creativeDefaults).toBeUndefined();
});

it('round-trips the expanded taxonomy alongside saved legacy values', () => {
  const project = testProject();
  project.settings.creativeDefaults = {
    hooks: ['追查旧案', '规则怪谈'],
    visualStyle: '冷调悬疑',
    tone: '克制冷峻',
    characterTags: ['记者'],
    relationships: ['搭档'],
    audience: '泛人群',
    chapterCount: 8,
  };
  expect(parseProject(project).settings.creativeDefaults).toEqual(
    project.settings.creativeDefaults,
  );
});
