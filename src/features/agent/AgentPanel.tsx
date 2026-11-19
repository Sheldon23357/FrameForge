import { lazy, memo, Suspense, useEffect, useRef, useState, type Ref } from 'react';
import {
  ArrowUp,
  ArrowCounterClockwise,
  Check,
  CircleNotch,
  GearSix,
  Plus,
  Robot,
  SidebarSimple,
  Square,
  Stack,
  Trash,
  WarningCircle,
} from '@phosphor-icons/react';
import { providerIds, providers } from '../../../packages/agent/settings';
import type { AgentTurn, ToolTrace } from '../../../packages/agent/types';
import { useAgent } from '../../store/agent';
import { useEditor } from '../../store/editor';
import { Button, IconButton, Modal } from '../../components/ui';
import { AgentContextPanel } from './AgentContextPanel';
import { StageCards } from './StageCards';
import { describeCreativeOptions } from '../../../packages/domain/creative-options';

const AgentMarkdown = lazy(() => import('./AgentMarkdown'));
const friendlySkills: Record<string, string> = {
  'frameforge-project-setup': '创意起步',
  'frameforge-story-outline': '全剧大纲',
  'frameforge-chapter-planning': '章节剧本',
  'frameforge-chapter-blueprint': '分支蓝图',
  'frameforge-node-screenplay': '节点剧本正文',
  'frameforge-node-storyboard': '节点分镜',
  'frameforge-game-balance': '路线与数值',
  'frameforge-script-review': '剧本诊断',
};

const ToolCallDetail = memo(function ToolCallDetail({
  trace,
  callNumber,
}: {
  trace: ToolTrace;
  callNumber?: number;
}) {
  const scenes = useEditor((s) => s.project.scenes);
  return (
    <div className="agent-tool-detail">
      <p>{trace.result?.summary ?? '正在执行…'}</p>
      {!!trace.result?.nodeIds?.length && (
        <div className="agent-tool-targets">
          {trace.result.nodeIds.slice(0, 6).map((id) => {
            const scene = scenes.find((s) => s.id === id);
            return (
              <button
                type="button"
                key={id}
                disabled={!scene}
                onClick={() => useEditor.getState().focusScene(id)}
              >
                {scene?.title ?? '节点已删除'}
              </button>
            );
          })}
        </div>
      )}
      <details>
        <summary>{callNumber ? `第 ${callNumber} 次调用详情` : '调用详情'}</summary>
        <pre>{trace.arguments}</pre>
        {trace.result?.data !== undefined && (
          <pre>{JSON.stringify(trace.result.data, null, 2)}</pre>
        )}
      </details>
    </div>
  );
});

function ToolTraceList({ traces }: { traces: ToolTrace[] }) {
  const groups: ToolTrace[][] = [];
  for (const trace of traces) {
    const previous = groups.at(-1);
    if (previous?.[0].name === trace.name) previous.push(trace);
    else groups.push([trace]);
  }
  return (
    <div className="agent-tool-list">
      {groups.map((group) => {
        const [first] = group;
        return (
          <details key={first.id} className="agent-tool-row">
            <summary>
              {group.some((trace) => trace.status === 'running') ? (
                <CircleNotch className="spin" size={13} />
              ) : group.some((trace) => trace.status === 'error') ? (
                <WarningCircle size={13} />
              ) : (
                <Check size={13} />
              )}
              <span>
                {first.label}
                {group.length > 1 && `（${group.length}）`}
              </span>
              <small>
                {first.mode === 'write' ? '编辑' : first.mode === 'view' ? '视图' : '读取'}
              </small>
            </summary>
            {group.map((trace, index) => (
              <ToolCallDetail
                key={trace.id}
                trace={trace}
                callNumber={group.length > 1 ? index + 1 : undefined}
              />
            ))}
          </details>
        );
      })}
    </div>
  );
}

const Turn = memo(function Turn({
  turn,
  busy,
  preview,
  thoughtSummary,
  canRollback,
  onRollback,
}: {
  turn: AgentTurn;
  busy: boolean;
  preview?: string;
  thoughtSummary?: string;
  canRollback?: boolean;
  onRollback?: (id: string) => void;
}) {
  const scenes = useEditor((s) => s.project.scenes);
  const creativeOptions = describeCreativeOptions(turn.creativeInput?.options);
  const requestedSkills = turn.creativeInput?.skills ?? [];
  const writes =
    turn.editCount ?? turn.traces.filter((t) => t.mode === 'write' && t.result?.ok).length;
  return (
    <article className="agent-turn">
      <div className="agent-user-message">{turn.user}</div>
      {(creativeOptions || requestedSkills.length > 0) && (
        <div className="agent-turn-context">
          {creativeOptions}
          {requestedSkills.length > 0 &&
            `${creativeOptions ? ' · ' : ''}指定技能 ${requestedSkills.map((name) => friendlySkills[name] ?? name).join('、')}`}
        </div>
      )}
      {!!turn.context?.selectedSceneIds.length && (
        <div className="agent-turn-context">
          引用：
          {turn.context.selectedSceneIds
            .slice(0, 3)
            .map((id) => scenes.find((s) => s.id === id)?.title ?? '节点已删除')
            .join('、')}
          {turn.context.selectedSceneIds.length > 3
            ? `等 ${turn.context.selectedSceneIds.length} 个节点`
            : ''}
        </div>
      )}
      <div className="agent-response">
        <div className="agent-response-heading">
          <Robot size={15} />
          <span>创作 Agent</span>
        </div>
        {!!turn.skills?.length && (
          <div className="agent-turn-context">
            技能：{turn.skills.map(({ name }) => name).join('、')}
          </div>
        )}
        {!!turn.traces.length && <ToolTraceList traces={turn.traces} />}
        {thoughtSummary && (
          <details className="agent-thought-summary" open>
            <summary>思考摘要</summary>
            <div>{thoughtSummary}</div>
          </details>
        )}
        {preview ? (
          <div className="agent-message-text agent-message-preview">{preview}</div>
        ) : (
          !!turn.assistant && (
            <Suspense fallback={<div className="agent-message-text">{turn.assistant}</div>}>
              <AgentMarkdown text={turn.assistant} />
            </Suspense>
          )
        )}
        {turn.status === 'running' && (
          <span className="agent-turn-pending">
            <CircleNotch size={12} className="spin" />
            处理中
          </span>
        )}
        <StageCards turn={turn} busy={busy} />
        {(writes > 0 || turn.status === 'completed') && (
          <div className="agent-change-status">
            {writes > 0 && (
              <span>
                {turn.reverted
                  ? '已撤销本轮修改'
                  : turn.committed
                    ? `已提交 ${writes} 项编辑${turn.outcome === 'partial' ? ' · 任务部分完成' : ''}`
                    : turn.status === 'running'
                      ? `${writes} 项编辑等待写入`
                      : '本轮编辑未提交'}
              </span>
            )}
            {turn.committed && !turn.reverted && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void useAgent.getState().undoTurn(turn.id)}
              >
                <ArrowCounterClockwise size={12} />
                撤销本轮
              </button>
            )}
            {turn.status === 'completed' && (
              <button
                type="button"
                disabled={busy || !canRollback}
                title={canRollback ? undefined : '此轮没有可恢复的工程版本'}
                onClick={() => onRollback?.(turn.id)}
              >
                回退到此轮
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
});
export function AgentPanel({
  visible,
  onOpenSettings,
  onCollapse,
  collapseButtonRef,
}: {
  visible: boolean;
  onOpenSettings(): void;
  onCollapse(): void;
  collapseButtonRef: Ref<HTMLButtonElement>;
}) {
  const state = useAgent();
  const selectedIds = useEditor((s) => s.selectedIds);
  const versions = useEditor((s) => s.versions);
  const playing = useEditor((s) => s.playing);
  const message = state.session ? (state.drafts[state.session.id] ?? '') : '';
  const setMessage = state.setDraftMessage;
  const list = useRef<HTMLDivElement>(null);
  const sticky = useRef(true);
  const contextMenu = useRef<HTMLDetailsElement>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [rollbackId, setRollbackId] = useState<string>();
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const el = contextMenu.current;
      if (el?.open && !el.contains(event.target as Node)) el.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  useEffect(() => {
    setRollbackId(undefined);
  }, [state.session?.id]);
  useEffect(() => {
    if (visible && sticky.current && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [
    visible,
    state.session?.id,
    state.session?.turns.length,
    state.pending,
    state.phase,
    state.preview,
    state.thoughtSummary,
  ]);
  const send = () => {
    if (!message.trim() || state.busy || state.loading) return;
    const text = message;
    setMessage('');
    sticky.current = true;
    void state.send(text);
  };
  const session = state.session;
  const rollbackIndex = session?.turns.findIndex((turn) => turn.id === rollbackId) ?? -1;
  const versionIds = new Set(versions.map((version) => version.id));
  return (
    <aside className="agent-panel" aria-label="创作 Agent 对话">
      <div className="panel-title">
        <h2>创作 Agent</h2>
        <div>
          <IconButton
            label="新建对话"
            disabled={state.busy || state.loading}
            onClick={() => {
              void state.newChat();
            }}
          >
            <Plus size={16} />
          </IconButton>
          <IconButton label="打开模型设置" onClick={onOpenSettings}>
            <GearSix size={16} />
          </IconButton>
          <IconButton
            label="折叠创作 Agent"
            aria-expanded={true}
            aria-controls="creative-agent"
            ref={collapseButtonRef}
            onClick={onCollapse}
          >
            <SidebarSimple size={16} />
          </IconButton>
        </div>
      </div>
      <div className="agent-chat-controls">
        <select
          aria-label="对话历史"
          disabled={state.busy || state.loading}
          value={session?.id ?? ''}
          onChange={(e) => {
            void state.selectChat(e.target.value);
            sticky.current = true;
          }}
        >
          {!session && <option value="">正在读取…</option>}
          {state.sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <IconButton
          label="删除当前对话"
          disabled={state.busy || state.loading || !session}
          onClick={() => void state.deleteChat()}
        >
          <Trash size={14} />
        </IconButton>
      </div>
      <div
        className="agent-conversation"
        ref={list}
        onScroll={() => {
          if (visible && list.current)
            sticky.current =
              list.current.scrollHeight - list.current.scrollTop - list.current.clientHeight < 80;
        }}
      >
        {state.loading ? (
          <p className="agent-empty">正在读取对话…</p>
        ) : !session?.turns.length && !state.pending ? (
          <div className="agent-empty">
            <Robot size={26} weight="thin" />
            <span>暂无对话</span>
          </div>
        ) : null}
        {session?.turns.map((turn) => (
          <Turn
            key={turn.id}
            turn={turn}
            busy={state.busy || state.loading}
            canRollback={Boolean(turn.rollback && versionIds.has(turn.rollback.versionId))}
            onRollback={setRollbackId}
          />
        ))}
        {state.pending && (
          <Turn
            turn={state.pending}
            busy={state.busy}
            preview={state.preview}
            thoughtSummary={state.thoughtSummary}
          />
        )}
        {state.error && (
          <div className="agent-panel-error" role="alert">
            <WarningCircle size={15} />
            <span>{state.error}</span>
          </div>
        )}
      </div>
      {rollbackIndex >= 0 && (
        <Modal
          open
          onOpenChange={(open) => !open && !state.loading && setRollbackId(undefined)}
          title={`回退到第 ${rollbackIndex + 1} 轮？`}
          description="工程将恢复到这轮结束时的版本。此轮之后的对话和未发送的输入将删除。"
        >
          {state.error && <p role="alert">{state.error}</p>}
          <div className="dialog-actions">
            <Button disabled={state.loading} onClick={() => setRollbackId(undefined)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={state.loading || state.busy || playing}
              onClick={async () => {
                if (rollbackId && (await state.rollbackToTurn(rollbackId))) {
                  sticky.current = true;
                  if (list.current) list.current.scrollTop = list.current.scrollHeight;
                  setRollbackId(undefined);
                }
              }}
            >
              {state.loading ? '正在回退…' : '确认回退'}
            </Button>
          </div>
        </Modal>
      )}
      <div className="agent-composer-area">
        {state.busy && (
          <div className="agent-run-status" role="status">
            <CircleNotch size={11} className="spin" />
            {state.phase}
          </div>
        )}
        <div className="agent-composer">
          <textarea
            aria-label="向创作 Agent 发送消息"
            placeholder="描述创作需求…"
            value={message}
            disabled={state.loading || !session}
            maxLength={16000}
            rows={2}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="agent-composer-footer">
            <details
              className="agent-context-details"
              ref={contextMenu}
              onToggle={(e) => {
                if (e.target === e.currentTarget) setContextOpen(e.currentTarget.open);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && e.currentTarget.open) {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.open = false;
                  e.currentTarget.querySelector('summary')?.focus();
                }
              }}
            >
              <summary
                aria-label="上下文与引用"
                title={`上下文与引用${selectedIds.length ? ` · 已选 ${selectedIds.length} 个节点` : ''}`}
              >
                <Stack size={16} />
              </summary>
              {contextOpen && (
                <AgentContextPanel
                  onClose={() => {
                    const el = contextMenu.current;
                    if (el) {
                      el.open = false;
                      el.querySelector('summary')?.focus();
                    }
                  }}
                />
              )}
            </details>
            <select
              aria-label="对话模型服务商"
              value={state.provider}
              disabled={state.busy || state.loading}
              onChange={(e) => state.setProvider(e.target.value as typeof state.provider)}
              title={state.modelNames[state.provider]}
            >
              {providerIds.map((id) => (
                <option key={id} value={id}>
                  {providers[id].name}
                </option>
              ))}
            </select>
            {state.busy ? (
              <IconButton label="停止创作" className="agent-send" onClick={state.stop}>
                <Square size={13} weight="fill" />
              </IconButton>
            ) : (
              <IconButton
                label="发送消息"
                className="agent-send"
                disabled={!message.trim() || !session || state.loading}
                onClick={send}
              >
                <ArrowUp size={17} weight="bold" />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
