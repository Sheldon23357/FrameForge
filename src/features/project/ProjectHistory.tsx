import { useState } from 'react';
import { Button, Modal } from '../../components/ui';
import { useEditor } from '../../store/editor';
import { platform } from '../../platform';
import { changedAssetIds, projectAtVersion } from '../../../packages/domain/project-versions';
import { commitAgentTransaction } from '../agent/editor-host';

const displayDate = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function ProjectHistory({ close }: { close: () => void }) {
  const versions = useEditor((state) => state.versions);
  const [selected, select] = useState(versions[0]?.id);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const entry = versions.find((version) => version.id === selected) ?? versions[0];
  const current = entry === versions[0];
  const restore = async () => {
    if (!entry || current || busy) return;
    const state = useEditor.getState();
    setBusy(true);
    setError('');
    try {
      const candidate = projectAtVersion(state.project, state.versions, entry.id);
      const assets = changedAssetIds(state.project, candidate);
      if (assets.length) await platform.ensureVersionAssets(candidate, assets);
      if (
        !commitAgentTransaction(state.project, candidate, [], state.changeSerial, {
          versionTitle: '回退到 ' + entry.title.slice(0, 90),
          historicalDraft: true,
        })
      )
        throw new Error('工程已发生变化。请重新选择版本。');
      const restored = useEditor.getState();
      if (assets.length && window.frameforge) {
        // Update the desktop asset catalog before the dialog releases the restored editor.
        await platform.autosave(restored.project).catch(() => {});
      }
      restored.notify('已回退工程，可在修改历史中恢复回退前的状态。');
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && !busy && close()}
      title="修改历史"
      description="本机最多保留最近 60 个版本。"
      className="project-history"
      wide
    >
      <div className="project-history-columns">
        <div className="project-history-list" aria-label="工程版本">
          {versions.map((version, index) => {
            const date = new Date(version.at);
            return (
              <button
                key={version.id}
                type="button"
                aria-pressed={version === entry}
                disabled={busy}
                onClick={() => {
                  select(version.id);
                  setConfirm(false);
                  setError('');
                }}
              >
                <strong>{version.title}</strong>
                <small>
                  {Number.isFinite(date.getTime()) ? displayDate.format(date) : '时间未知'}
                  {index === 0 && <span>当前版本</span>}
                </small>
              </button>
            );
          })}
        </div>
        <section className="project-history-detail" aria-label="版本改动">
          <h3>{entry?.title}</h3>
          {entry?.details.length ? (
            <ul>
              {entry.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : (
            <p>从此版本开始记录工程修改。</p>
          )}
          {confirm && <p>回退后，回退前的状态仍可在历史中恢复。</p>}
          {error && (
            <p role="alert" className="project-history-error">
              {error}
            </p>
          )}
        </section>
      </div>
      {!current && (
        <div className="dialog-actions project-history-actions">
          {confirm && (
            <Button disabled={busy} onClick={() => setConfirm(false)}>
              取消
            </Button>
          )}
          {confirm ? (
            <Button variant="primary" disabled={busy} onClick={() => void restore()}>
              {busy ? '正在回退…' : '确认回退'}
            </Button>
          ) : (
            <Button onClick={() => setConfirm(true)}>回退到此版本</Button>
          )}
        </div>
      )}
    </Modal>
  );
}
