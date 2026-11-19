import { describe, expect, it } from 'vitest';
import { testProject } from '../fixtures/project';
import {
  initialVersion,
  projectAtVersion,
  recordVersion,
  versionInfo,
} from '../../packages/domain/project-versions';
import { createEditorTools } from '../../packages/agent/tools';

describe('工程修改历史', () => {
  it('summarizes edits and reverses array insertions, field additions and layout edits', () => {
    const base = testProject();
    const edited = structuredClone(base);
    edited.scenes[0].title = '改过的开场';
    edited.scenes[0].timeline = { videoClips: [], audioClips: [] };
    edited.items.unshift({ id: 'test_item', name: '铜钥匙', description: '', initial: 0 });
    edited.layout[edited.scenes[0].id].x += 20;
    const versions = recordVersion(initialVersion(base), base, edited)!;
    expect(versions[0].details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('时间线'),
        expect.stringContaining('铜钥匙'),
        '调整蓝图布局',
      ]),
    );
    expect(projectAtVersion(edited, versions, versions[1].id)).toEqual(base);
    expect(edited.scenes[0].title).toBe('改过的开场');
  });

  it('groups typing and keeps the pre-rollback version available', () => {
    const original = testProject();
    const first = { ...original, title: '第一' };
    const initial = initialVersion(original);
    const versions = recordVersion(initial, original, first)!;
    const next = { ...original, title: '第一章' };
    const merged = recordVersion(versions, first, next, true)!;
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe(versions[0].id);
    const rollback = projectAtVersion(next, merged, initial[0].id);
    const logged = recordVersion(merged, next, rollback, false, '回退到初始版本')!;
    expect(projectAtVersion(rollback, logged, merged[0].id).title).toBe('第一章');
    expect(recordVersion(merged, next, original, true)).toEqual(initial);
  });

  it('provides paginated history and applies an explicitly selected version to the Agent draft', () => {
    const base = testProject();
    const current = { ...base, title: '后来修改的作品' };
    const versions = recordVersion(initialVersion(base), base, current)!;
    const context = {
      project: current,
      activeChapterId: null,
      selectedIds: [],
      intents: [],
      versions: versions.map(versionInfo),
      projectAtVersion: (id: string) => projectAtVersion(current, versions, id),
    };
    const registry = createEditorTools();
    const page = registry.execute('list_project_versions', '{"limit":1}', context);
    expect(page.data).toMatchObject({ total: 2, nextOffset: 1 });
    const restore = registry.execute(
      'restore_project_version',
      JSON.stringify({ versionId: versions[1].id }),
      context,
    );
    expect(restore.ok).toBe(true);
    expect(context.project.title).toBe(base.title);
    expect(current.title).toBe('后来修改的作品');
  });
});
