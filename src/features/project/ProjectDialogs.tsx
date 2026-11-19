import { useEffect, useId, useState } from 'react';
import {
  ArrowRight,
  FolderOpen,
  MonitorPlay,
  CheckCircle,
  WarningCircle,
  Globe,
} from '@phosphor-icons/react';
import { makeProject } from '../../../packages/domain/schema';
import { validateProject } from '../../../packages/domain/validation';
import { useEditor } from '../../store/editor';
import { platform, isDesktop } from '../../platform';
import { Button, Field, Modal } from '../../components/ui';
import type { ExportTarget } from '../../../packages/export/web';
import { ProjectHistory } from './ProjectHistory';
export type ProjectDialog = 'new' | 'export' | 'help' | 'history' | null;
function projectError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': Error:\s*/,
    '',
  );
}
export function ProjectDialogs({
  dialog,
  setDialog,
}: {
  dialog: ProjectDialog;
  setDialog: (d: ProjectDialog) => void;
}) {
  const p = useEditor((s) => s.project);
  const directoryId = useId();
  const [name, setName] = useState('我的互动影游');
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  const [defaultDirectory, setDefaultDirectory] = useState('');
  const [customDirectory, setCustomDirectory] = useState<string>();
  const [output, setOutput] = useState('');
  const [exportTarget, setExportTarget] = useState<ExportTarget>(isDesktop ? 'windows' : 'web');
  const issues = validateProject(p);
  const errors = issues.filter((d) => d.severity === 'error');
  useEffect(() => {
    if (dialog !== 'new' || !window.frameforge) return;
    let current = true;
    void window.frameforge.defaultProjectDirectory(name.trim()).then(
      (directory) => {
        if (current) setDefaultDirectory(directory);
      },
      (error) => {
        if (current) setCreateError(projectError(error));
      },
    );
    return () => {
      current = false;
    };
  }, [dialog, name]);
  const closeNew = () => {
    setCreateError('');
    setCustomDirectory(undefined);
    setDialog(null);
  };
  const chooseDirectory = async () => {
    if (!window.frameforge) return;
    setBusy(true);
    setCreateError('');
    try {
      const chosen = await window.frameforge.chooseProjectDirectory();
      if (chosen) setCustomDirectory(chosen);
    } catch (error) {
      setCreateError(projectError(error));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    setBusy(true);
    setCreateError('');
    try {
      const next = makeProject();
      next.id = crypto.randomUUID();
      next.title = name.trim() || next.title;
      let filePath: string | undefined;
      if (window.frameforge) {
        await window.frameforge.autosave(useEditor.getState().project);
        filePath = await window.frameforge.newProject(next, customDirectory);
      } else {
        await platform.newProject(next);
      }
      useEditor.getState().load(next, filePath);
      useEditor.setState({ page: 'blueprint' });
      closeNew();
      useEditor.getState().notify('新工程已创建。');
    } catch (e) {
      setCreateError(projectError(e));
    } finally {
      setBusy(false);
    }
  };
  const exportGame = async () => {
    setBusy(true);
    try {
      const path = await platform.exportGame(p, exportTarget);
      if (path) {
        setOutput(path);
        useEditor
          .getState()
          .notify(exportTarget === 'web' ? '网页版游戏导出完成。' : '独立游戏导出完成。');
      }
    } catch (e) {
      useEditor.getState().notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {dialog === 'history' && <ProjectHistory close={() => setDialog(null)} />}
      <Modal
        open={dialog === 'new'}
        onOpenChange={(v) => {
          if (!v && !busy) closeNew();
        }}
        title="新建作品"
      >
        <Field label="作品名称">
          <input autoFocus disabled={busy} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {isDesktop && (
          <div className="field">
            <label className="field-label" htmlFor={directoryId}>
              作品保存目录
            </label>
            <div className="project-directory-row">
              <input
                id={directoryId}
                readOnly
                value={customDirectory ?? defaultDirectory}
                title={customDirectory ?? defaultDirectory}
              />
              <Button disabled={busy} onClick={chooseDirectory}>
                <FolderOpen size={15} />
                自定义
              </Button>
              {customDirectory && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setCustomDirectory(undefined);
                    setCreateError('');
                  }}
                >
                  恢复默认
                </Button>
              )}
            </div>
          </div>
        )}
        {createError && <p role="alert">{createError}</p>}
        <div className="dialog-actions new-project-actions">
          <Button disabled={busy} onClick={closeNew}>
            取消
          </Button>
          <Button variant="primary" busy={busy} onClick={create}>
            创建工程
            <ArrowRight size={15} />
          </Button>
        </div>
      </Modal>
      <Modal
        open={dialog === 'export'}
        onOpenChange={(v) => {
          if (!v && !busy) {
            setDialog(null);
            setOutput('');
          }
        }}
        title={output ? '导出完成' : '导出作品'}
      >
        {output ? (
          <div className="export-success">
            <CheckCircle size={46} weight="duotone" />
            <h3>{p.title}</h3>
            <p>{output}</p>
            {exportTarget === 'web' && (
              <p>
                上传全部文件到网站目录，通过 HTTP / HTTPS 访问 index.html
                即可游玩。部署步骤见包内「部署说明.txt」。
              </p>
            )}
            {isDesktop ? (
              <Button variant="primary" onClick={() => platform.reveal(output)}>
                <FolderOpen size={16} />
                打开导出目录
              </Button>
            ) : (
              <p>ZIP 已下载，解压后上传其中的全部文件。</p>
            )}
          </div>
        ) : (
          <>
            <Field label="导出格式">
              <select
                value={exportTarget}
                onChange={(e) => setExportTarget(e.target.value as ExportTarget)}
              >
                <option value="windows" disabled={!isDesktop}>
                  Windows 独立游戏
                </option>
                <option value="web">网页版游戏（HTML5）</option>
              </select>
            </Field>
            <div className="export-target">
              {exportTarget === 'web' ? (
                <Globe size={31} weight="duotone" />
              ) : (
                <MonitorPlay size={31} weight="duotone" />
              )}
              <div>
                <strong>
                  {exportTarget === 'web' ? '网页版游戏 · 静态网站' : 'Windows 独立游戏'}
                </strong>
              </div>
              <span className="tag">{exportTarget === 'web' ? 'HTML5' : 'PC'}</span>
            </div>
            {exportTarget === 'web' && (
              <p className="inline-note">
                包含网页播放器、剧情和素材。支持部署到域名根目录或子目录，无需游戏后端；存档保存在玩家浏览器中。
              </p>
            )}
            <div className="export-stats">
              <div>
                <strong>{p.scenes.length}</strong>
                <span>剧情节点</span>
              </div>
              <div>
                <strong>{p.scenes.filter((s) => s.kind === 'ending').length}</strong>
                <span>故事结局</span>
              </div>
              <div>
                <strong>{p.assets.length}</strong>
                <span>媒体素材</span>
              </div>
            </div>
            <div className={`export-check ${errors.length ? 'has-errors' : ''}`}>
              {errors.length ? <WarningCircle size={19} /> : <CheckCircle size={19} />}
              <div>
                <strong>
                  {errors.length ? `${errors.length} 个问题需要修复` : '工程检查通过'}
                </strong>
                {(errors.length > 0 || issues.length > 0) && (
                  <span>{errors.length ? errors[0].message : `${issues.length} 条提醒`}</span>
                )}
              </div>
              <Button
                variant="ghost"
                onClick={() => {
                  setDialog(null);
                  useEditor.setState({ diagnosticsOpen: true, page: 'blueprint' });
                }}
              >
                查看
              </Button>
            </div>
            {!isDesktop && exportTarget === 'windows' && (
              <p className="inline-note">
                当前为浏览器预览。独立游戏导出需要运行桌面版本；可先保存含素材的工程压缩包。
              </p>
            )}
            <div className="dialog-actions">
              <Button onClick={() => setDialog(null)}>取消</Button>
              <Button
                variant="primary"
                busy={busy}
                disabled={errors.length > 0 || (exportTarget === 'windows' && !isDesktop)}
                onClick={exportGame}
              >
                导出作品
                <ArrowRight size={16} />
              </Button>
            </div>
          </>
        )}
      </Modal>
      <Modal open={dialog === 'help'} onOpenChange={(v) => !v && setDialog(null)} title="快捷键">
        <div className="keyboard-grid">
          {[
            ['Ctrl + S', '保存工程'],
            ['Ctrl + Z', '撤销'],
            ['Ctrl + Shift + Z', '重做'],
            ['Ctrl + D', '复制选中节点'],
            ['Delete', '删除选中节点'],
            ['Space + 拖动', '平移画布'],
            ['Space', '试玩时切换到下一页剧情文字'],
            ['按住 Ctrl', '试玩和游玩时以 10 倍速播放，松开恢复'],
            ['Ctrl + Space', '试玩时跳到当前节点的最后一页剧情文字'],
            ['Shift + 点击', '多选节点'],
            ['右键画布', '添加节点'],
          ].map(([key, label]) => (
            <div key={key}>
              <kbd>{key}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <Button variant="primary" onClick={() => setDialog(null)}>
            关闭
          </Button>
        </div>
      </Modal>
    </>
  );
}
