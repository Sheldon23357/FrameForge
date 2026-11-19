import { describe, expect, it } from 'vitest';
import { webAssetPath, webAssetPaths } from '../../packages/export/web';
import { testProject } from '../fixtures/project';

describe('web export asset paths', () => {
  it('preserves unicode filenames and normalizes Windows separators', () => {
    expect(webAssetPath('assets\\第一幕 #1.mp4')).toBe('assets/第一幕 #1.mp4');
    const project = testProject();
    project.assets[1].path = project.assets[0].path;
    project.assets[0].thumbnail = 'data:image/png;base64,AAAA';
    expect(webAssetPaths(project)).not.toContain(project.assets[0].thumbnail);
    expect(webAssetPaths(project).filter((path) => path === project.assets[0].path)).toHaveLength(
      1,
    );
  });
  it('rejects absolute paths and paths that escape the game directory', () => {
    for (const path of [
      '../secret',
      '/absolute',
      'assets/../secret',
      'C:\\secret',
      'https://a/b',
      '//a/b',
      'assets/./a',
      'assets/\0a',
    ])
      expect(() => webAssetPath(path)).toThrow();
  });
});
