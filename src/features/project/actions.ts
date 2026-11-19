import { useState } from 'react';
import { platform, assetUrl, isDesktop } from '../../platform';
import { probeMedia } from '../../platform/browser';
import { useEditor } from '../../store/editor';
import { readVersionHistory, saveVersionHistory } from '../../store/version-history';
import type { AudioAssetCategory } from '../../../packages/domain/assets';
export function useProjectActions() {
  const [busy, setBusy] = useState<string | null>(null);
  const notify = useEditor((s) => s.notify);
  const run = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  return {
    busy,
    save: (saveAs = false) =>
      run('save', async () => {
        const { project: p, versions } = useEditor.getState();
        useEditor.setState({ saveStatus: 'saving' });
        const file = await platform.saveProject(p, saveAs);
        if (file) {
          await saveVersionHistory(p, versions, file, true).catch(() =>
            notify('工程已保存，修改历史未能保存。', 'error'),
          );
          useEditor.setState({
            filePath: file,
            dirty: useEditor.getState().project !== p,
            saveStatus: 'saved',
            savedAt: new Date().toISOString(),
          });
          notify(isDesktop ? '工程和素材已保存。' : '工程压缩包已下载，包含全部素材。');
        } else useEditor.setState({ saveStatus: 'idle' });
      }),
    open: (inNewWindow = false) =>
      run('open', async () => {
        if (inNewWindow && window.frameforge) {
          await window.frameforge.openProjectWindow();
          return;
        }
        if (isDesktop) await platform.autosave(useEditor.getState().project);
        const boot = await platform.openProject();
        if (boot) {
          const versions = await readVersionHistory(boot.project, boot.filePath);
          useEditor.getState().load(boot.project, boot.filePath, versions);
          notify(boot.recovered ? '已恢复该工程的自动保存进度。' : '工程已打开。');
        }
      }),
    importAssets: (category?: AudioAssetCategory) =>
      run('import', async () => {
        const assets = await platform.importAssets(undefined, category);
        if (!assets.length) return;
        for (const a of assets)
          if (!a.durationMs || !a.thumbnail) {
            const metadata = await probeMedia(assetUrl(a), a.type);
            if (metadata.durationMs) a.durationMs = metadata.durationMs;
            if (metadata.width) {
              a.width = metadata.width;
              a.height = metadata.height;
            }
            if (!a.thumbnail && metadata.thumbnail) a.thumbnail = metadata.thumbnail;
          }
        useEditor.getState().addAssets(assets);
        notify(`已导入 ${assets.length} 个素材。`);
      }),
  };
}
