import { SceneProperties } from './SceneProperties';
import { ChoicesPanel } from './ChoicesPanel';
import { EventsPanel } from './EventsPanel';
import { NodeNotes } from './NodeNotes';
import { useEffect, useRef, useState } from 'react';
import {
  FilmStrip,
  GitBranch,
  Trophy,
  Play,
  PencilSimple,
  Trash,
  Copy,
  SlidersHorizontal,
  SidebarSimple,
} from '@phosphor-icons/react';
import { useEditor } from '../../store/editor';

import { type Scene } from '../../../packages/domain/schema';
import { Button, Empty, IconButton, Field } from '../../components/ui';
import { StartSettings } from './StartSettings';

export function Inspector({ onCollapse }: { onCollapse(): void }) {
  const p = useEditor((s) => s.project);
  const ids = useEditor((s) => s.selectedIds);
  const patch = useEditor((s) => s.patchScene);
  const scene = p.scenes.find((s) => s.id === ids[0]);
  const [tab, setTab] = useState<'properties' | 'choices' | 'events' | 'notes'>('properties');
  useEffect(() => setTab('properties'), [scene?.id]);
  const collapse = (
    <IconButton
      label="折叠节点检查器"
      aria-expanded={true}
      aria-controls="node-inspector"
      onClick={onCollapse}
    >
      <SidebarSimple size={16} mirrored />
    </IconButton>
  );
  if (ids.length > 1)
    return (
      <aside className="inspector" aria-label="节点检查器">
        <div className="panel-title">
          <h2>批量选择</h2>
          {collapse}
        </div>
        <Empty icon={<Copy size={28} />}>已选择 {ids.length} 个节点</Empty>
        <SectionMove ids={ids} />
        <div className="inspector-actions">
          <Button onClick={() => useEditor.getState().duplicate(ids)}>
            <Copy size={15} />
            复制节点组
          </Button>
          <Button variant="danger" onClick={() => useEditor.getState().deleteScenes(ids)}>
            <Trash size={15} />
            删除节点组
          </Button>
        </div>
      </aside>
    );
  if (!scene)
    return (
      <aside className="inspector" aria-label="节点检查器">
        <div className="panel-title">
          <h2>检查器</h2>
          {collapse}
        </div>
        <Empty icon={<SlidersHorizontal size={30} weight="thin" />}>未选择节点</Empty>
        <div className="inspector-summary">
          <h3>{p.title}</h3>
          <p>{p.description}</p>
          <dl>
            <div>
              <dt>剧情节点</dt>
              <dd>{p.scenes.length}</dd>
            </div>
            <div>
              <dt>游戏属性</dt>
              <dd>{p.variables.length}</dd>
            </div>
            <div>
              <dt>游戏道具</dt>
              <dd>{p.items.length}</dd>
            </div>
          </dl>
        </div>
      </aside>
    );
  const s = scene;
  const Icon = s.kind === 'branch' ? GitBranch : s.kind === 'ending' ? Trophy : FilmStrip;
  const change = (v: Partial<Scene>) => patch(s.id, v);
  return (
    <aside className="inspector" aria-label="节点检查器">
      <div className="panel-title">
        <h2>节点检查器</h2>
        <div>
          <IconButton label="复制节点" onClick={() => useEditor.getState().duplicate([s.id])}>
            <Copy size={15} />
          </IconButton>
          <IconButton label="删除节点" onClick={() => useEditor.getState().deleteScenes([s.id])}>
            <Trash size={15} />
          </IconButton>
          {collapse}
        </div>
      </div>
      <div className="inspector-node-heading">
        <span className={`type-icon ${s.kind}`}>
          <Icon size={19} weight="duotone" />
        </span>
        <div>
          <SceneTitle key={s.id} title={s.title} onChange={(title) => change({ title })} />
          <span>
            {s.kind === 'branch' ? '条件分支' : s.kind === 'ending' ? '故事结局' : '视频片段'}
            <span className="muted">
              {' '}
              / {String(p.scenes.findIndex((n) => n.id === s.id) + 1).padStart(2, '0')}
            </span>
          </span>
        </div>
      </div>
      <div className="inspector-chapter-row">
        <select
          aria-label="所属章节"
          value={s.chapterId}
          onChange={(e) => useEditor.getState().moveScenes([s.id], e.target.value)}
        >
          {p.chapters.map((chapter) => (
            <option key={chapter.id} value={chapter.id}>
              {chapter.title}
            </option>
          ))}
        </select>
        <StartSettings project={p} scene={s} />
      </div>
      <div className="inspector-tabs">
        <button
          className={tab === 'properties' ? 'active' : ''}
          onClick={() => setTab('properties')}
        >
          属性
        </button>
        {s.kind !== 'ending' && (
          <button className={tab === 'choices' ? 'active' : ''} onClick={() => setTab('choices')}>
            {s.kind === 'branch' ? '分支' : '选项'}
            <span>{s.choices.length}</span>
          </button>
        )}
        <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>
          事件<span>{s.events.length}</span>
        </button>
        <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
          节点内容
        </button>
      </div>
      <div className="inspector-scroll" key={s.id}>
        {tab === 'properties' && (
          <SceneProperties
            project={p}
            scene={s}
            change={change}
            onShowChoices={() => setTab('choices')}
          />
        )}
        {tab === 'choices' && <ChoicesPanel project={p} scene={s} change={change} />}
        {tab === 'events' && <EventsPanel project={p} scene={s} change={change} />}
        {tab === 'notes' && <NodeNotes value={s.notes} onChange={(notes) => change({ notes })} />}
      </div>
      <div className="inspector-bottom">
        <Button
          variant="ghost"
          onClick={() => useEditor.setState({ playing: true, playFrom: s.id })}
        >
          <Play size={14} weight="fill" />
          从此节点试玩
        </Button>
      </div>
    </aside>
  );
}

function SceneTitle({ title, onChange }: { title: string; onChange: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  return (
    <div className="inspector-scene-title">
      {editing ? (
        <input
          aria-label="节点名称"
          autoFocus
          value={title}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            e.preventDefault();
            editButton.current?.focus();
          }}
        />
      ) : (
        <h2 title={title}>{title}</h2>
      )}
      <IconButton label="编辑节点名称" ref={editButton} onClick={() => setEditing(true)}>
        <PencilSimple size={14} />
      </IconButton>
    </div>
  );
}

function SectionMove({ ids }: { ids: string[] }) {
  const p = useEditor((s) => s.project);
  return (
    <div className="inspector-section">
      <Field label="批量移入章节">
        <select value="" onChange={(e) => useEditor.getState().moveScenes(ids, e.target.value)}>
          <option value="" disabled>
            选择目标章节
          </option>
          {p.chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}
