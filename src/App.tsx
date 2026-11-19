import { useEffect, useRef, useState } from 'react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import {
  FilmStrip,
  Graph,
  SlidersHorizontal,
  GearSix,
  Plus,
  FolderOpen,
  FloppyDisk,
  Play,
  Export,
  ArrowCounterClockwise,
  ArrowClockwise,
  ClockCounterClockwise,
  CaretDown,
  CaretRight,
  Question,
  CheckCircle,
  WarningCircle,
  CircleNotch,
  MagnifyingGlass,
  Command,
  SidebarSimple,
  Robot,
  BookOpen,
  ListBullets,
  Eye,
  PencilSimple,
  X,
} from '@phosphor-icons/react';
import { isDesktop, platform } from './platform';
import { useEditor } from './store/editor';
import { readVersionHistory, saveVersionHistory } from './store/version-history';
import { validateProject } from '../packages/domain/validation';
import { Button, IconButton } from './components/ui';
import { Blueprint } from './features/blueprint/Blueprint';
import { Library } from './features/library/Library';
import { Inspector } from './features/inspector/Inspector';
import { GameData } from './features/data/GameData';
import { WorldSettings } from './features/world/WorldSettings';
import { Settings } from './features/project/Settings';
import { AgentSettings } from './features/agent/AgentSettings';
import { Diagnostics } from './features/project/Diagnostics';
import { ProjectDialogs, type ProjectDialog } from './features/project/ProjectDialogs';
import { useProjectActions } from './features/project/actions';
import { Player } from './features/player/Player';
import { AgentPanel } from './features/agent/AgentPanel';
import { useAgent } from './store/agent';
import { PanelResizeHandle, usePanelWidths } from './components/PanelResizeHandle';
import { TimelineEditor } from './features/timeline/TimelineEditor';
import { StoryOutline } from './features/project/StoryOutline';
import { Screenplay } from './features/project/Screenplay';

function usePanelCollapsed(key: string) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(key) === 'true';
    } catch {
      return false;
    }
  });
  return [
    collapsed,
    () => {
      const next = !collapsed;
      setCollapsed(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        /* The panel remains usable when storage is unavailable. */
      }
    },
  ] as const;
}

export default function App() {
  const p = useEditor((s) => s.project);
  const versions = useEditor((s) => s.versions);
  const filePath = useEditor((s) => s.filePath);
  const page = useEditor((s) => s.page);
  const outlineTarget = useEditor((s) => s.outlineTarget);
  const search = useEditor((s) => s.search);
  const activeChapterId = useEditor((s) => s.activeChapterId);
  const past = useEditor((s) => s.past);
  const future = useEditor((s) => s.future);
  const playing = useEditor((s) => s.playing);
  const playFrom = useEditor((s) => s.playFrom);
  const timelineNodeId = useEditor((s) => s.timelineNodeId);
  const checks = useEditor((s) => s.diagnosticsOpen);
  const toast = useEditor((s) => s.toast);
  const saveStatus = useEditor((s) => s.saveStatus);
  const [dialog, setDialog] = useState<ProjectDialog>(null);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const appSettingsTrigger = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState('');
  const [standalone, setStandalone] = useState(false);
  const [libraryCollapsed, toggleLibrary] = usePanelCollapsed('frameforge.library-collapsed.v1');
  const [inspectorCollapsed, toggleInspector] = usePanelCollapsed(
    'frameforge.inspector-collapsed.v1',
  );
  const [agentCollapsed, toggleAgent] = usePanelCollapsed('frameforge.agent-collapsed.v1');
  const libraryToggleButton = useRef<HTMLButtonElement>(null);
  const inspectorToggleButton = useRef<HTMLButtonElement>(null);
  const expandAgentButton = useRef<HTMLButtonElement>(null);
  const collapseAgentButton = useRef<HTMLButtonElement>(null);
  const actions = useProjectActions();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const isCanvas = page === 'blueprint';
  const inspectorOpen = isCanvas && !inspectorCollapsed;
  const panels = usePanelWidths(workspaceRef, {
    ready,
    canvas: isCanvas,
    agentOpen: !agentCollapsed,
    libraryOpen: !libraryCollapsed,
    inspectorOpen,
  });
  const toggleAgentAndFocus = () => {
    const nextButton = agentCollapsed ? collapseAgentButton : expandAgentButton;
    toggleAgent();
    requestAnimationFrame(() => nextButton.current?.focus());
  };
  const scriptWorkspace = page === 'outline' || page === 'screenplay';
  const [outlinePreview, setOutlinePreview] = useState(true);
  const scriptTabs = [
    ['brief', '项目简报'],
    ['outline', '剧情大纲'],
    ['chapter', '分章节大纲'],
    ['screenplay', '章节剧本'],
  ] as const;
  const scriptTab =
    page === 'screenplay'
      ? 'screenplay'
      : outlineTarget === 'brief'
        ? 'brief'
        : outlineTarget?.startsWith('chapter:')
          ? 'chapter'
          : 'outline';
  const selectScriptTab = (tab: (typeof scriptTabs)[number][0]) => {
    if (tab === 'screenplay') useEditor.getState().setPage('screenplay');
    else
      useEditor.setState({
        page: 'outline',
        outlineTarget:
          tab === 'chapter' ? `chapter:${activeChapterId ?? p.chapters[0]?.id ?? ''}` : tab,
      });
  };
  useEffect(() => {
    if (isDesktop && ready && !standalone) document.title = `${p.title} · 帧叙 FrameForge`;
  }, [p.title, ready, standalone]);
  useEffect(() => setOutlinePreview(true), [p.id]);
  useEffect(() => {
    if (ready && !standalone) void useAgent.getState().openProject(p.id);
  }, [ready, standalone, p.id]);
  useEffect(() => {
    if (!appSettingsOpen && ready && !standalone) void useAgent.getState().refreshModels();
  }, [appSettingsOpen, ready, standalone]);
  useEffect(() => {
    platform
      .bootstrap()
      .then(async (boot) => {
        const history =
          boot.mode === 'editor'
            ? await readVersionHistory(boot.project, boot.filePath)
            : undefined;
        useEditor.getState().load(boot.project, boot.filePath, history);
        setStandalone(boot.mode === 'player');
        setReady(true);
        if (boot.recovered) useEditor.getState().notify('已恢复上次的本地创作进度。');
      })
      .catch((e) => setBootError((e as Error).message));
  }, []);
  useEffect(() => {
    if (!ready || standalone || actions.busy === 'open' || actions.busy === 'save') return;
    const timer = setTimeout(() => {
      if (useEditor.getState().project !== p) return;
      useEditor.setState({ saveStatus: 'saving' });
      platform
        .autosave(p)
        .then(async () => {
          await saveVersionHistory(p, versions, filePath).catch(() => {
            useEditor.getState().notify('自动保存成功，修改历史未能保存。', 'error');
          });
          if (useEditor.getState().project === p)
            useEditor.setState({ saveStatus: 'saved', savedAt: new Date().toISOString() });
        })
        .catch((e) => {
          useEditor.setState({ saveStatus: 'error' });
          useEditor
            .getState()
            .notify(`自动保存失败：${e instanceof Error ? e.message : String(e)}`, 'error');
        });
    }, 800);
    return () => clearTimeout(timer);
  }, [p, versions, filePath, ready, standalone, actions.busy]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (playing || standalone) return;
      if (document.querySelector('.app-settings-dialog')) return;
      const typing = !!(e.target as HTMLElement).closest(
        'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
      );
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void actions.save(e.shiftKey);
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void actions.open(e.shiftKey);
      }
      if (typing || dialog || document.querySelector('[role="dialog"]')) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? useEditor.getState().redo() : useEditor.getState().undo();
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        useEditor.getState().redo();
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        useEditor.getState().duplicate(useEditor.getState().selectedIds);
      }
      if (
        !mod &&
        !e.altKey &&
        useEditor.getState().page === 'blueprint' &&
        ['v', 'b', 'e'].includes(e.key.toLowerCase())
      ) {
        e.preventDefault();
        useEditor
          .getState()
          .addScene(
            e.key.toLowerCase() === 'b'
              ? 'branch'
              : e.key.toLowerCase() === 'e'
                ? 'ending'
                : 'video',
          );
      }
      if (e.key === 'F5') {
        e.preventDefault();
        if (!useEditor.getState().project.startNodeId) {
          useEditor.getState().notify('请先为第一章设置起点。', 'error');
          return;
        }
        useEditor.setState({ playing: true, playFrom: undefined });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [playing, standalone, dialog, actions]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (window.frameforge) return;
      if (useEditor.getState().saveStatus === 'saving') {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
  useEffect(() => {
    if (!ready || standalone || !window.frameforge) return;
    const bridge = window.frameforge;
    return bridge.onBeforeClose(() => {
      useAgent.getState().stop();
      const state = useEditor.getState();
      bridge
        .autosave(state.project)
        .then(() =>
          saveVersionHistory(state.project, state.versions, state.filePath).catch(() => {}),
        )
        .then(() => useAgent.getState().flush())
        .then(() => bridge.completeClose(true))
        .catch((e) => {
          useEditor
            .getState()
            .notify(`关闭前保存失败：${e instanceof Error ? e.message : String(e)}`, 'error');
          void bridge.completeClose(false);
        });
    });
  }, [ready, standalone]);
  const issues = validateProject(p);
  const errors = issues.filter((d) => d.severity === 'error');
  if (bootError)
    return (
      <div className="boot-screen">
        <WarningCircle size={35} />
        <h2>工程未能打开</h2>
        <p>{bootError}</p>
        <Button onClick={() => location.reload()}>重试</Button>
      </div>
    );
  if (!ready)
    return (
      <div className="boot-screen">
        <FilmStrip size={40} weight="duotone" />
        <h2>
          帧叙 <span>FrameForge</span>
        </h2>
        <CircleNotch className="spin" size={20} />
      </div>
    );
  if (standalone) return <Player project={p} standalone />;
  return (
    <>
      <div className="studio" inert={playing ? true : undefined}>
        <header className="app-header">
          <div className="brand">
            <span className="brand-mark">
              <FilmStrip size={24} weight="duotone" />
            </span>
            <div>
              <strong>帧叙</strong>
              <span>FRAMEFORGE</span>
            </div>
          </div>
          <span className="header-separator" />
          <Dropdown.Root>
            <Dropdown.Trigger asChild>
              <button className="project-menu">
                <span>{p.title}</span>
                <CaretDown size={12} />
              </button>
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content
                className="dropdown-content file-menu"
                sideOffset={17}
                align="start"
              >
                <Dropdown.Label>工程</Dropdown.Label>
                <Dropdown.Item onSelect={() => setDialog('new')}>
                  <Plus />
                  新建作品
                </Dropdown.Item>
                <Dropdown.Item onSelect={() => actions.open()}>
                  <FolderOpen />
                  打开工程<span>Ctrl O</span>
                </Dropdown.Item>
                <Dropdown.Item onSelect={() => actions.save()}>
                  <FloppyDisk />
                  保存工程<span>Ctrl S</span>
                </Dropdown.Item>
                <Dropdown.Item onSelect={() => actions.save(true)}>
                  <FloppyDisk />
                  另存为<span>Ctrl ⇧ S</span>
                </Dropdown.Item>
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
          <span className={`save-indicator ${saveStatus}`}>
            {saveStatus === 'saving' ? (
              <CircleNotch className="spin" size={12} />
            ) : saveStatus === 'error' ? (
              <WarningCircle size={12} />
            ) : (
              <CheckCircle size={12} />
            )}
            <span>
              {saveStatus === 'saving'
                ? '正在保存…'
                : saveStatus === 'saved'
                  ? '已自动保存'
                  : saveStatus === 'error'
                    ? '保存失败'
                    : '本地草稿'}
            </span>
          </span>
          <div className="header-actions">
            <div className="history-actions">
              <IconButton
                label="撤销（Ctrl Z）"
                disabled={!past.length}
                onClick={() => useEditor.getState().undo()}
              >
                <ArrowCounterClockwise size={17} />
              </IconButton>
              <IconButton
                label="重做（Ctrl Shift Z）"
                disabled={!future.length}
                onClick={() => useEditor.getState().redo()}
              >
                <ArrowClockwise size={17} />
              </IconButton>
            </div>
            <IconButton label="修改历史" onClick={() => setDialog('history')}>
              <ClockCounterClockwise size={19} />
            </IconButton>
            <span className="header-separator" />
            <IconButton
              label="保存工程（Ctrl S）"
              disabled={!!actions.busy}
              onClick={() => actions.save()}
            >
              <FloppyDisk size={19} />
            </IconButton>
            <Button
              className="preview-button"
              disabled={!p.startNodeId}
              onClick={() => useEditor.setState({ playing: true, playFrom: undefined })}
            >
              <Play size={15} weight="fill" />
              试玩<kbd>F5</kbd>
            </Button>
            <Button variant="primary" onClick={() => setDialog('export')}>
              <Export size={16} />
              导出作品
            </Button>
          </div>
        </header>
        <div
          ref={workspaceRef}
          className={`studio-body${isCanvas ? ' canvas-workspace' : ''}`}
          style={{
            gridTemplateColumns: `var(--navigation-width, 62px) ${panels.agent.width + panels.library.width}px minmax(0, 1fr)${inspectorOpen ? ` ${panels.inspector.width}px` : ''}`,
          }}
        >
          <nav className="navigation-rail" aria-label="主导航">
            <div>
              {(
                [
                  { id: 'blueprint', icon: Graph, label: '画布' },
                  { id: 'outline', icon: ListBullets, label: '剧本' },
                  { id: 'world', icon: BookOpen, label: '设定' },
                  { id: 'data', icon: SlidersHorizontal, label: '参数' },
                  { id: 'settings', icon: GearSix, label: '项目设置' },
                ] as const
              ).map(({ id, icon: Icon, label }) => (
                <button
                  key={id}
                  className={page === id || (id === 'outline' && scriptWorkspace) ? 'active' : ''}
                  title={label}
                  aria-label={label}
                  aria-current={
                    page === id || (id === 'outline' && scriptWorkspace) ? 'page' : undefined
                  }
                  onClick={() => {
                    if (id !== 'outline' || !scriptWorkspace) useEditor.getState().setPage(id);
                  }}
                >
                  <Icon
                    size={22}
                    weight={
                      page === id || (id === 'outline' && scriptWorkspace) ? 'duotone' : 'regular'
                    }
                  />
                  <span>{label.slice(0, 2)}</span>
                </button>
              ))}
            </div>
            <div>
              {agentCollapsed && (
                <button
                  type="button"
                  title="展开创作 Agent"
                  aria-label="展开创作 Agent"
                  aria-expanded={false}
                  aria-controls="creative-agent"
                  ref={expandAgentButton}
                  onClick={toggleAgentAndFocus}
                >
                  <Robot size={22} />
                  <span>Agent</span>
                </button>
              )}
              <button title="快捷键" aria-label="快捷键" onClick={() => setDialog('help')}>
                <Question size={22} />
              </button>
              <button
                title="设置"
                aria-label="设置"
                aria-haspopup="dialog"
                ref={appSettingsTrigger}
                onClick={() => setAppSettingsOpen(true)}
              >
                <GearSix size={22} />
                <span>设置</span>
              </button>
              <div className="rail-avatar">F</div>
            </div>
          </nav>
          <div className={`left-workspace${panels.stackLibrary ? ' stacked' : ''}`}>
            <div
              id="creative-agent"
              className="agent-workspace-panel"
              hidden={agentCollapsed}
              style={{ width: panels.agent.width }}
            >
              <AgentPanel
                visible={!agentCollapsed}
                onOpenSettings={() => setAppSettingsOpen(true)}
                onCollapse={toggleAgentAndFocus}
                collapseButtonRef={collapseAgentButton}
              />
              {!agentCollapsed && (
                <PanelResizeHandle side="left" label="调整 Agent 面板宽度" {...panels.agent} />
              )}
            </div>
            {isCanvas && (
              <div
                id="creative-library"
                className="library-workspace-panel"
                hidden={libraryCollapsed}
                style={panels.stackLibrary ? undefined : { width: panels.library.width }}
              >
                <Library
                  visible={!libraryCollapsed}
                  onCollapse={() => {
                    toggleLibrary();
                    libraryToggleButton.current?.focus();
                  }}
                />
                {!libraryCollapsed && !panels.stackLibrary && (
                  <PanelResizeHandle side="left" label="调整创作资源面板宽度" {...panels.library} />
                )}
              </div>
            )}
          </div>
          <div className="main-workspace">
            <div className="workspace-topbar">
              <div>
                {isCanvas && (
                  <IconButton
                    className="workspace-panel-toggle"
                    label={libraryCollapsed ? '展开创作资源' : '折叠创作资源'}
                    aria-expanded={!libraryCollapsed}
                    aria-controls="creative-library"
                    ref={libraryToggleButton}
                    onClick={toggleLibrary}
                  >
                    <SidebarSimple size={17} weight={libraryCollapsed ? 'regular' : 'duotone'} />
                  </IconButton>
                )}
                <span>{p.title}</span>
                <CaretRight size={12} />
                <strong>
                  {isCanvas
                    ? '画布'
                    : page === 'data'
                      ? '参数'
                      : scriptWorkspace
                        ? '剧本'
                        : page === 'world'
                          ? '设定'
                          : '项目设置'}
                </strong>
                {isCanvas && (
                  <select
                    className="chapter-scope"
                    aria-label="当前章节"
                    value={activeChapterId ?? ''}
                    onChange={(e) => useEditor.getState().setChapter(e.target.value || null)}
                  >
                    <option value="">全部章节</option>
                    {p.chapters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {isCanvas ? (
                <div className="canvas-actions">
                  <div className="canvas-search">
                    <MagnifyingGlass size={14} />
                    <input
                      aria-label="搜索蓝图节点"
                      placeholder="查找节点…"
                      value={search}
                      onChange={(e) => useEditor.getState().setSearch(e.target.value)}
                    />
                    <kbd>⌕</kbd>
                  </div>
                  <IconButton
                    className="workspace-panel-toggle"
                    label={inspectorCollapsed ? '展开节点检查器' : '折叠节点检查器'}
                    aria-expanded={!inspectorCollapsed}
                    aria-controls="node-inspector"
                    ref={inspectorToggleButton}
                    onClick={toggleInspector}
                  >
                    <SidebarSimple
                      size={17}
                      weight={inspectorCollapsed ? 'regular' : 'duotone'}
                      mirrored
                    />
                  </IconButton>
                </div>
              ) : null}
            </div>
            {isCanvas ? (
              <>
                <Blueprint />
                {checks && <Diagnostics />}
              </>
            ) : page === 'data' ? (
              <GameData />
            ) : page === 'world' ? (
              <WorldSettings key={`world:${p.id}`} />
            ) : !scriptWorkspace ? (
              <Settings />
            ) : null}
            <div className="script-workspace" hidden={!scriptWorkspace}>
              {scriptWorkspace && (
                <div className="script-toolbar">
                  <div className="script-tabs" role="tablist" aria-label="剧本视图">
                    {scriptTabs.map(([tab, label], index) => (
                      <button
                        type="button"
                        key={tab}
                        id={`script-tab-${tab}`}
                        role="tab"
                        aria-selected={scriptTab === tab}
                        aria-controls="script-tab-panel"
                        tabIndex={scriptTab === tab ? 0 : -1}
                        onClick={() => selectScriptTab(tab)}
                        onKeyDown={(event) => {
                          const offset = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
                          const next =
                            event.key === 'Home'
                              ? 0
                              : event.key === 'End'
                                ? scriptTabs.length - 1
                                : offset
                                  ? (index + offset + scriptTabs.length) % scriptTabs.length
                                  : undefined;
                          if (next === undefined) return;
                          event.preventDefault();
                          const [nextTab] = scriptTabs[next];
                          selectScriptTab(nextTab);
                          document.getElementById(`script-tab-${nextTab}`)?.focus();
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {page === 'outline' && (
                    <div className="story-design-modes" role="group" aria-label="文档视图">
                      <button
                        type="button"
                        aria-pressed={!outlinePreview}
                        onClick={() => setOutlinePreview(false)}
                      >
                        <PencilSimple size={15} aria-hidden="true" /> 编辑
                      </button>
                      <button
                        type="button"
                        aria-pressed={outlinePreview}
                        onClick={() => setOutlinePreview(true)}
                      >
                        <Eye size={16} aria-hidden="true" /> 预览
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div
                id="script-tab-panel"
                className="script-tab-panel"
                role="tabpanel"
                aria-labelledby={`script-tab-${scriptTab}`}
              >
                <StoryOutline
                  key={`outline:${p.id}`}
                  hidden={page !== 'outline'}
                  preview={outlinePreview}
                  onEdit={() => setOutlinePreview(false)}
                />
                <Screenplay key={`screenplay:${p.id}`} hidden={page !== 'screenplay'} />
              </div>
            </div>
          </div>
          {isCanvas && (
            <div id="node-inspector" className="right-workspace-panel" hidden={inspectorCollapsed}>
              {inspectorOpen && (
                <PanelResizeHandle side="right" label="调整检查器宽度" {...panels.inspector} />
              )}
              <Inspector
                onCollapse={() => {
                  toggleInspector();
                  inspectorToggleButton.current?.focus();
                }}
              />
            </div>
          )}
        </div>
        <footer className="app-statusbar">
          <div>
            <span className="status-dot" />
            <span>本地工作区</span>
            <span className="status-divider" />
            <span>{p.scenes.length} 个节点</span>
            <span>{p.chapters.length} 个章节</span>
            <span>
              {p.scenes.reduce(
                (n, s) => n + s.choices.length + (s.nextId && !s.choices.length ? 1 : 0),
                0,
              )}{' '}
              条连接
            </span>
          </div>
          <button
            className={errors.length ? 'has-errors' : ''}
            onClick={() => {
              useEditor.setState({
                page: 'blueprint',
                diagnosticsOpen: !checks,
              });
            }}
          >
            {errors.length ? <WarningCircle size={13} /> : <CheckCircle size={13} />}
            <span>
              {errors.length
                ? `${errors.length} 个问题`
                : issues.length
                  ? `${issues.length} 条提醒`
                  : '工程检查通过'}
            </span>
            <CaretRight size={11} />
          </button>
          <div>
            <span>Windows</span>
            <span className="status-divider" />
            <button onClick={() => setDialog('help')}>
              <Command size={12} />
              快捷键
            </button>
          </div>
        </footer>
      </div>
      <ProjectDialogs dialog={dialog} setDialog={setDialog} />
      {timelineNodeId && p.scenes.some((s) => s.id === timelineNodeId) && (
        <TimelineEditor
          key={`${p.id}:${timelineNodeId}`}
          nodeId={timelineNodeId}
          onClose={() => useEditor.setState({ timelineNodeId: undefined })}
        />
      )}
      <AgentSettings
        open={appSettingsOpen}
        onOpenChange={setAppSettingsOpen}
        returnFocusRef={appSettingsTrigger}
      />
      {playing && (
        <Player
          project={p}
          from={playFrom}
          onClose={() => useEditor.setState({ playing: false })}
        />
      )}
      {toast && !playing && (
        <div className={`toast ${toast.kind}`} role="status">
          {toast.kind === 'error' ? <WarningCircle size={18} /> : <CheckCircle size={18} />}
          <span>{toast.message}</span>
          <IconButton label="关闭通知" onClick={() => useEditor.setState({ toast: undefined })}>
            <X size={14} />
          </IconButton>
        </div>
      )}
    </>
  );
}
