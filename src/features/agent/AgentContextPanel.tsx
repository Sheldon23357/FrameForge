import { useState } from 'react';
import { CaretRight, PushPin as Pin, Stack, X } from '@phosphor-icons/react';
import { editorTools, useAgent } from '../../store/agent';
import { useEditor } from '../../store/editor';
import { IconButton } from '../../components/ui';

const groupLabels: Record<string, string> = {
  story: '剧情与章节',
  choices: '剧情选项与事件',
  project: '工程、素材与版本',
  rules: '属性与道具',
  analysis: '检查与试玩',
  context: '对话与记忆',
  workflow: '草稿续跑',
  timeline: '时间线与音轨',
  world: '角色与场景设定',
  design: '剧情大纲',
};
const tabs = ['references', 'capabilities'] as const;
export function AgentContextPanel({ onClose }: { onClose(): void }) {
  const [tab, setTab] = useState<(typeof tabs)[number]>('references');
  const project = useEditor((s) => s.project);
  const selected = useEditor((s) => s.selectedIds);
  const chapterId = useEditor((s) => s.activeChapterId);
  const session = useAgent((s) => s.session);
  const busy = useAgent((s) => s.busy);
  const stats = useAgent((s) => s.stats);
  const tools = editorTools.list().filter(({ name }) => {
    if (name === 'read_skill') return Boolean(window.frameforge?.agentSkills);
    if (
      [
        'generate_world_reference',
        'generate_shot_image',
        'generate_image_batch',
        'generate_production_audio',
      ].includes(name)
    )
      return Boolean(window.frameforge?.generateWorldReference);
    if (name === 'import_assets') return Boolean(window.frameforge?.stageAssetImport);
    return true;
  });
  const groups = [...new Set(tools.map((t) => t.category))];
  const pinned = session?.pinnedSceneIds ?? [];
  const allPinned = selected.length > 0 && selected.every((id) => pinned.includes(id));
  return (
    <section className="agent-context-content" role="dialog" aria-label="上下文与引用">
      <header className="context-panel-heading">
        <strong>上下文</strong>
        <IconButton label="关闭上下文" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>
      <div className="context-panel-tabs" role="tablist" aria-label="上下文分类">
        {tabs.map((id, index) => (
          <button
            type="button"
            role="tab"
            id={`context-tab-${id}`}
            key={id}
            aria-selected={tab === id}
            aria-controls={`context-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(e) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
              e.preventDefault();
              const next = tabs[e.key === 'Home' ? 0 : e.key === 'End' ? 1 : 1 - index];
              setTab(next);
              document.getElementById(`context-tab-${next}`)?.focus();
            }}
          >
            {id === 'references' ? '引用' : '能力'}
            <span>
              {id === 'references' ? new Set([...selected, ...pinned]).size : tools.length}
            </span>
          </button>
        ))}
      </div>
      <div
        className="context-panel-body"
        id={`context-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`context-tab-${tab}`}
      >
        {tab === 'references' ? (
          <>
            <dl className="context-project-info">
              <div>
                <dt>工程</dt>
                <dd title={project.title}>{project.title}</dd>
              </div>
              <div>
                <dt>章节</dt>
                <dd>{project.chapters.find((c) => c.id === chapterId)?.title ?? '全部章节'}</dd>
              </div>
            </dl>
            {!!selected.length && (
              <section className="context-reference-section">
                <div className="context-section-heading">
                  <h3>
                    选中节点 <span>自动引用</span>
                  </h3>
                  <button
                    className="context-pin-action"
                    type="button"
                    aria-label="固定选中节点"
                    disabled={busy || !session || allPinned}
                    onClick={() => useAgent.getState().pinSelection()}
                  >
                    <Pin size={12} />
                    {allPinned ? '已固定' : '固定'}
                  </button>
                </div>
                <div className="agent-context-chips">
                  {selected.slice(0, 5).map((id) => (
                    <span key={id} title={project.scenes.find((s) => s.id === id)?.title ?? id}>
                      <Stack size={12} />
                      <span>{project.scenes.find((s) => s.id === id)?.title ?? '节点已删除'}</span>
                    </span>
                  ))}
                  {selected.length > 5 && <span>+{selected.length - 5}</span>}
                </div>
              </section>
            )}
            {!!pinned.length && (
              <section className="context-reference-section">
                <div className="context-section-heading">
                  <h3>固定引用</h3>
                  <span>{pinned.length}</span>
                </div>
                <div className="agent-context-chips pinned">
                  {pinned.map((id) => (
                    <span key={id} title={project.scenes.find((s) => s.id === id)?.title ?? id}>
                      <Pin size={11} />
                      <span>{project.scenes.find((s) => s.id === id)?.title ?? '节点已删除'}</span>
                      <button
                        type="button"
                        aria-label={`取消固定 ${project.scenes.find((s) => s.id === id)?.title ?? id}`}
                        disabled={busy}
                        onClick={() => useAgent.getState().unpin(id)}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              </section>
            )}
            {!!session?.memory.summary && (
              <details className="context-memory">
                <summary>
                  <CaretRight size={12} />
                  <span>历史记忆</span>
                  <small>已整理 {session.memory.through} 轮</small>
                </summary>
                <p>{session.memory.summary}</p>
              </details>
            )}
          </>
        ) : (
          <div className="context-capability-groups">
            {groups.map((group) => {
              const rows = tools.filter((t) => t.category === group);
              return (
                <details className="context-capability-group" key={group}>
                  <summary>
                    <CaretRight size={12} />
                    <span>{groupLabels[group] ?? '其他能力'}</span>
                    <small>{rows.length}</small>
                  </summary>
                  <ul>
                    {rows.map((tool) => (
                      <li key={tool.name} title={tool.description}>
                        {tool.label}
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        )}
      </div>
      {stats && (
        <footer className="context-panel-footer">
          <span>上下文用量</span>
          <span title="按字符估算，非精确计费 token 数">
            约 {stats.estimatedTokens.toLocaleString()} / {stats.budgetTokens.toLocaleString()}
          </span>
        </footer>
      )}
    </section>
  );
}
