import { memo, useState } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import {
  FilmStrip,
  GitBranch,
  Flag,
  ArrowRight,
  LockSimple,
  Trophy,
  Lightning,
  Check,
  Plus,
  NotePencil,
} from '@phosphor-icons/react';
import { Project, Scene, chapterTitle, sceneLabel } from '../../../packages/domain/schema';
import { assetUrl } from '../../platform';
import { time } from '../../components/ui';
import { conditionSummary } from '../rules/ConditionEditor';
import { useEditor } from '../../store/editor';
import { editTimeline, nodeDuration } from '../../../packages/domain/timeline';
import { productionShotFrames } from '../../../packages/domain/production-shots';
import { commitAgentTransaction } from '../agent/editor-host';
export type StoryFlowNode = Node<{ scene: Scene; project: Project; draft: boolean }, 'story'>;
export const StoryNode = memo(function StoryNode({
  data,
  selected,
  isConnectable,
}: NodeProps<StoryFlowNode>) {
  const { scene: s, project: p, draft } = data;
  const asset = p.assets.find((a) => a.id === s.assetId);
  const frames = productionShotFrames(p.productionShots, p.assets, s.id);
  const [frameKey, setFrameKey] = useState<string>();
  const frame = frames.find(({ key }) => key === frameKey) ?? frames.at(-1);
  const frameIndex = frame ? frames.indexOf(frame) : -1;
  const poster = (frameKey ? frame?.asset : asset) ?? frame?.asset;
  const isStart = p.startNodeId === s.id;
  const Icon = s.kind === 'branch' ? GitBranch : s.kind === 'ending' ? Trophy : FilmStrip;
  const draggedAssetId = useEditor((state) => state.draggedAssetId);
  const [dropTarget, setDropTarget] = useState(false);
  return (
    <article
      className={`story-node ${s.kind} ${selected ? 'selected' : ''} ${draft ? 'agent-draft' : ''}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
      <div className="node-kind">
        <span>
          <Icon size={14} weight="duotone" />
          {s.kind === 'branch' ? '条件分支' : s.kind === 'ending' ? '故事结局' : '视频片段'}
        </span>
        <div className="node-meta">
          {draft && <span className="node-draft-badge">草稿</span>}
          {s.notes && <NotePencil size={12} aria-label="有备注" />}
          {isStart ? (
            <span className="start-badge">
              <Flag size={10} weight="fill" />
              起点
            </span>
          ) : (
            <span className="node-short-id">
              {String(p.scenes.findIndex((n) => n.id === s.id) + 1).padStart(2, '0')}
            </span>
          )}
        </div>
      </div>
      {s.kind !== 'branch' && (
        <div
          className={`node-poster ${draggedAssetId ? 'drop-available' : ''} ${dropTarget ? 'is-drop-target' : ''}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('application/frameforge-asset')) return;
            e.preventDefault();
            e.stopPropagation();
            if (draft) {
              e.dataTransfer.dropEffect = 'none';
              return;
            }
            e.dataTransfer.dropEffect = 'copy';
            setDropTarget(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null))
              setDropTarget(false);
          }}
          onDrop={(e) => {
            if (draft) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            const assetId = e.dataTransfer.getData('application/frameforge-asset');
            const asset = p.assets.find((a) => a.id === assetId);
            if (!asset || (asset.type === 'audio' && !s.timeline)) return;
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(false);
            if (s.timeline) {
              const state = useEditor.getState();
              try {
                const next = structuredClone(state.project);
                editTimeline(next, s.id, {
                  action: 'add',
                  track: asset.type === 'audio' ? 'audio' : 'video',
                  assetId,
                });
                if (!commitAgentTransaction(state.project, next, [], state.changeSerial))
                  throw new Error('无法应用素材，请检查节点时间线。');
              } catch (error) {
                state.notify((error as Error).message, 'error');
              }
              useEditor.setState({ draggedAssetId: undefined });
              return;
            }
            useEditor.getState().patchScene(s.id, {
              assetId,
              trimStartMs: 0,
              trimEndMs: undefined,
              durationMs: asset.durationMs || 8000,
            });
            useEditor.setState({ draggedAssetId: undefined, selectedIds: [s.id] });
          }}
        >
          {poster ? (
            <img
              src={assetUrl(poster, true)}
              alt={frame && poster === frame.asset ? frame.label : ''}
              draggable={false}
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="node-no-media">
              <FilmStrip size={28} weight="thin" />
              <Plus size={15} className="poster-add" />
            </div>
          )}
          {!!frames.length && (
            <div className="node-frame-count nodrag nopan">
              <button
                type="button"
                aria-label="查看制作镜头帧"
                title={frame && poster === frame.asset ? frame.label : '查看制作镜头帧'}
                onClick={(event) => {
                  event.stopPropagation();
                  const index = poster === frame?.asset ? (frameIndex + 1) % frames.length : 0;
                  setFrameKey(frames[index].key);
                }}
              >
                {frames.length} 张制作镜头图
                {poster === frame?.asset &&
                  frames.length > 1 &&
                  ` · ${frameIndex + 1}/${frames.length}`}
              </button>
              {asset && frameKey && (
                <button
                  type="button"
                  aria-label="返回节点封面"
                  onClick={(event) => {
                    event.stopPropagation();
                    setFrameKey(undefined);
                  }}
                >
                  <FilmStrip size={12} />
                </button>
              )}
            </div>
          )}
          {s.kind === 'ending' && (
            <div className="ending-poster-overlay">
              <Trophy size={26} weight="duotone" />
            </div>
          )}
          {s.kind === 'video' && (
            <span className="duration">
              {s.timeline ? `${s.timeline.videoClips.length} 段 · ` : ''}
              {time(nodeDuration(p, s))}
            </span>
          )}
        </div>
      )}
      <div className="node-body">
        <div className="node-chapter">
          {chapterTitle(p, s.chapterId)}
          {p.chapters.find((c) => c.id === s.chapterId)?.startNodeId === s.id ? ' · 入口' : ''}
        </div>
        <h3>{s.title}</h3>
        {s.events.length > 0 && (
          <span className="node-event">
            <Lightning size={11} weight="fill" />
            {s.events.length} 个事件
          </span>
        )}
      </div>
      {s.kind === 'ending' ? (
        <div className="node-ending">
          <Check size={12} />
          {s.endingLabel}
        </div>
      ) : s.choices.length ? (
        <div className="node-choices">
          {s.choices.map((c, i) => (
            <div className="node-choice" key={c.id} title={conditionSummary(c.condition, p)}>
              <span className="choice-letter">
                {s.kind === 'branch' ? <GitBranch size={11} /> : String.fromCharCode(65 + i)}
              </span>
              <span>{c.label}</span>
              {!(c.condition.kind === 'all' && !c.condition.children.length) && (
                <LockSimple size={11} className="muted" />
              )}
              <Handle
                type="source"
                position={Position.Right}
                id={c.id}
                isConnectable={isConnectable}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className={`node-next ${s.nextId ? 'linked' : ''}`} aria-label="下一个节点">
          {s.nextId && <span>{p.scenes.find((n) => n.id === s.nextId)?.title}</span>}
          {s.nextId ? <ArrowRight size={13} /> : <Plus size={13} />}
          <Handle type="source" position={Position.Right} id="next" isConnectable={isConnectable} />
        </div>
      )}
      {s.kind !== 'ending' && (
        <div className="node-cross-links">
          {(s.choices.length
            ? s.choices.map((c) => ({ id: c.id, label: c.label, targetId: c.targetId }))
            : [{ id: 'next', label: '自动跳转', targetId: s.nextId }]
          )
            .filter((link) => {
              const target = p.scenes.find((n) => n.id === link.targetId);
              return target && target.chapterId !== s.chapterId;
            })
            .map((link) => (
              <button
                key={link.id}
                className="nodrag nopan"
                title={`${link.label} → ${sceneLabel(p, link.targetId)}`}
                disabled={draft}
                onClick={(e) => {
                  e.stopPropagation();
                  useEditor.getState().focusScene(link.targetId);
                }}
              >
                <ArrowRight size={12} />
                <span>跨章 → {sceneLabel(p, link.targetId)}</span>
              </button>
            ))}
        </div>
      )}
    </article>
  );
});
