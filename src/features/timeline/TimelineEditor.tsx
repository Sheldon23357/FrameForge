import { useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CaretDown,
  FileText,
  FilmStrip,
  MusicNotes,
  Play,
  Pause,
  Plus,
  Trash,
  UploadSimple,
  ArrowCounterClockwise,
  ArrowClockwise,
  Scissors,
  Cursor,
  Magnet,
  SkipBack,
  SkipForward,
  Minus,
  MagnifyingGlass,
  CornersOut,
  GitBranch,
  Lightning,
} from '@phosphor-icons/react';
import {
  storyboardPagesSchema,
  type Project,
  type Scene,
  type VideoClip,
  type AudioClip,
} from '../../../packages/domain/schema';
import { snapStoryTime } from '../../../packages/domain/story-time';
import {
  activeStoryboard,
  storyboardOverlayPages,
  dialogueEndMs,
  editableTimeline,
  editTimeline,
  nodeDuration,
  playerTextLabels,
  playerTextPlayback,
  stillClipsFor,
  videoAt,
  type TimelineCommand,
} from '../../../packages/domain/timeline';
import { productionShotFrames } from '../../../packages/domain/production-shots';
import { ProductionShotDetails } from './ProductionShotDetails';
import { mergeProjectEdits } from '../../../packages/domain/project-merge';
import { validateProject } from '../../../packages/domain/validation';
import { useEditor } from '../../store/editor';
import { assetUrl, platform } from '../../platform';
import { probeMedia } from '../../platform/browser';
import { Button, Field, IconButton, Modal, time } from '../../components/ui';
import { StoryTimeInput } from '../../components/StoryTimeInput';
import { StoryboardPageFields } from '../../components/StoryboardPageFields';
import { commitAgentTransaction } from '../agent/editor-host';
import { TimelineMedia } from '../player/TimelineMedia';
import { ClipFilmstrip, ClipWaveform } from './TimelineClipMedia';

const timecode = (ms: number) =>
  `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${time(ms)}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;

type ClipDrag =
  | { clip: VideoClip | AudioClip; mode: 'in' | 'out' | 'audio_move' | 'audio_end' }
  | { mode: 'duration'; update: (project: Project, delta: number) => void };

export function openNodeTimeline(nodeId: string) {
  const state = useEditor.getState();
  const scene = state.project.scenes.find((s) => s.id === nodeId);
  if (!scene || scene.kind !== 'video') return;
  try {
    editableTimeline(state.project, scene);
    useEditor.setState({ timelineNodeId: nodeId, selectedIds: [nodeId] });
  } catch (e) {
    state.notify((e as Error).message, 'error');
  }
}
function Seconds({
  label,
  value,
  onChange,
  nullable = false,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  nullable?: boolean;
}) {
  const [text, setText] = useState(value === null ? '' : String(value / 1000));
  useEffect(
    () => setText(value === null ? '' : String(Number((value / 1000).toFixed(3)))),
    [value],
  );
  const apply = () => {
    if (!text && nullable) onChange(null);
    else if (text && Number.isFinite(Number(text)) && Number(text) >= 0)
      onChange(Math.round(Number(text) * 1000));
    else setText(value === null ? '' : String(value / 1000));
  };
  return (
    <Field label={label}>
      <input
        type="number"
        min="0"
        step="0.1"
        value={text}
        placeholder={nullable ? '片尾' : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </Field>
  );
}
export function TimelineEditor({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const liveProject = useEditor((state) => state.project);
  const [base] = useState(() => liveProject);
  const [previewFrameKey, setPreviewFrameKey] = useState<string>();
  const [inspectedShotId, setInspectedShotId] = useState<string>();
  const [draft, setDraft] = useState(() => {
    const p = structuredClone(base);
    const s = p.scenes.find((s) => s.id === nodeId)!;
    const duration = nodeDuration(p, s);
    s.timeline = editableTimeline(p, s);
    if (!s.timeline.videoClips.length && !s.timeline.stillClips?.length) s.durationMs = duration;
    return p;
  });
  const [past, setPast] = useState<Project[]>([]);
  const [future, setFuture] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState(() => {
    const timeline = draft.scenes.find((s) => s.id === nodeId)!.timeline!;
    return (
      timeline.videoClips[0]?.id ?? timeline.stillClips?.[0]?.id ?? timeline.audioClips[0]?.id ?? ''
    );
  });
  const [storyboardPageIndex, setStoryboardPageIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [mediaFilter, setMediaFilter] = useState<'all' | 'video' | 'image' | 'audio'>('all');
  const [pickedImages, setPickedImages] = useState<string[]>([]);
  const [snap, setSnap] = useState(true);
  const [dragging, setDragging] = useState(false);
  const clipDrag = useRef<
    | (ClipDrag & {
        base: Project;
        x: number;
        px: number;
        last?: Project;
      })
    | null
  >(null);
  const suppressClick = useRef(false);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [zoom, setZoom] = useState(1);
  const tracksViewport = useRef<HTMLDivElement>(null);
  const [tracksElement, setTracksElement] = useState<HTMLDivElement | null>(null);
  const [trackViewportWidth, setTrackViewportWidth] = useState(1000);
  const [trackHeight, setTrackHeight] = useState(() => {
    try {
      return Math.max(
        150,
        Math.min(
          window.innerHeight * 0.5,
          Number(localStorage.getItem('frameforge.timeline.height')) || window.innerHeight * 0.34,
        ),
      );
    } catch {
      return window.innerHeight * 0.34;
    }
  });
  const resizeDrag = useRef<{ y: number; height: number; value: number } | null>(null);
  const persistHeight = (value: number) => {
    try {
      localStorage.setItem('frameforge.timeline.height', String(value));
    } catch {
      /* Layout remains usable without storage. */
    }
  };
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const element = tracksElement;
    if (!element) return;
    tracksViewport.current = element;
    setTrackViewportWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setTrackViewportWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [tracksElement]);
  const scene = draft.scenes.find((s) => s.id === nodeId)!;
  const timeline = scene.timeline!;
  const shots = (draft.productionShots ?? []).filter((shot) => shot.nodeId === nodeId);
  const shotFrames = productionShotFrames(shots, draft.assets, nodeId);
  const previewFrame = shotFrames.find(({ key }) => key === previewFrameKey);
  const inspectedShot = shots.find(({ id }) => id === inspectedShotId);

  const storyboard = activeStoryboard(scene);
  const storyboardOverlay = storyboardOverlayPages(draft, scene);
  const editableStoryboard = scene.storyboardPages?.length ? scene.storyboardPages : undefined;
  const playerText = playerTextPlayback(draft, scene);
  const currentTextPage = Math.min(storyboardPageIndex, (editableStoryboard?.length ?? 1) - 1);
  const duration = nodeDuration(draft, scene);
  const stills = stillClipsFor(draft, scene);
  const hasStills = stills.length > 0;
  const hasVideo = timeline.videoClips.length > 0;
  const selectedStill = stills.find((clip) => clip.id === selectedId) ?? stills[0];
  const selectedStillIndex = selectedStill ? stills.indexOf(selectedStill) : -1;
  const selectedStillAsset = draft.assets.find(({ id }) => id === selectedStill?.assetId);
  const dialogueEnd = dialogueEndMs(scene);
  const earlyChoice =
    scene.choices.length > 0 && Math.min(scene.choicesAtMs ?? duration, duration) < dialogueEnd;
  const mediaAssets = draft.assets.filter(
    (asset) => (!hasStills || asset.type !== 'video') && (!hasVideo || asset.type !== 'image'),
  );
  const filter =
    (hasStills && mediaFilter === 'video') || (hasVideo && mediaFilter === 'image')
      ? 'all'
      : mediaFilter;
  const pictureSummary = storyboard
    ? `${storyboard.length} 页剧情文字`
    : hasStills
      ? `${stills.length} 张图片`
      : `${timeline.videoClips.length} 段视频`;
  const visibleAssets = mediaAssets.filter(
    (a) =>
      (filter === 'all' || a.type === filter) && a.name.toLowerCase().includes(query.toLowerCase()),
  );
  const video = timeline.videoClips.find((c) => c.id === selectedId);
  const audio = timeline.audioClips.find((c) => c.id === selectedId);
  const selected = video ?? audio;
  const editingStoryboard = !!editableStoryboard && !selected && !selectedId;
  const source = draft.assets.find((a) => a.id === selected?.assetId);
  const changed = past.length > 0;
  const publish = (next: Project) => {
    setPast((rows) => [...rows, draft].slice(-60));
    setFuture([]);
    setDraft(next);
    setPlaying(false);
    setError('');
    setPosition((old) =>
      Math.min(
        old,
        nodeDuration(
          next,
          next.scenes.find((s) => s.id === nodeId)!,
        ),
      ),
    );
  };
  const command = (input: TimelineCommand) => {
    try {
      const next = structuredClone(draft);
      const id = editTimeline(next, nodeId, input);
      publish(next);
      if (input.action === 'remove' || id) setSelectedId(id && input.action !== 'remove' ? id : '');
      return true;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const patchScene = (patch: Partial<Scene>) => {
    const next = structuredClone(draft);
    Object.assign(
      next.scenes.find((s) => s.id === nodeId)!,
      patch,
    );
    publish(next);
  };
  const undo = () => {
    if (!past.length) return;
    setFuture([draft, ...future]);
    setDraft(past[past.length - 1]);
    setPast(past.slice(0, -1));
    setPlaying(false);
    setError('');
  };
  const redo = () => {
    if (!future.length) return;
    setPast([...past, draft]);
    setDraft(future[0]);
    setFuture(future.slice(1));
    setPlaying(false);
    setError('');
  };
  useEffect(() => {
    setPosition((old) => Math.min(old, duration));
  }, [duration]);
  useEffect(() => {
    if (position >= duration) setPlaying(false);
  }, [position, duration]);
  useEffect(() => {
    if (!playing || timeline.videoClips.length) return;
    let last = performance.now();
    const timer = setInterval(
      () => {
        const now = performance.now();
        if (!document.hidden) setPosition((old) => Math.min(duration, old + now - last));
        last = now;
      },
      stills.length > 1 ? 16 : 50,
    );
    return () => clearInterval(timer);
  }, [playing, duration, timeline.videoClips.length, stills.length]);
  const importAssets = async () => {
    setBusy(true);
    setPlaying(false);
    try {
      const assets = await platform.importAssets();
      for (const a of assets) {
        if (!a.durationMs || (!a.thumbnail && a.type !== 'audio'))
          Object.assign(a, await probeMedia(assetUrl(a), a.type));
      }
      if (!alive.current || !assets.length) return;
      const next = structuredClone(draft);
      for (const asset of assets) {
        const index = next.assets.findIndex((a) => a.id === asset.id);
        if (index >= 0) next.assets[index] = asset;
        else next.assets.push(asset);
      }
      publish(next);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const apply = () => {
    const issues = validateProject(draft).filter(
      (i) => i.nodeId === nodeId && i.severity === 'error',
    );
    if (issues.length) {
      setError(issues.map((i) => i.message).join(' '));
      return;
    }
    if (!changed) {
      onClose();
      return;
    }
    const latest = useEditor.getState();
    const merged = mergeProjectEdits(base, latest.project, draft);
    if ('error' in merged) {
      setError(merged.error);
      return;
    }
    if (!commitAgentTransaction(latest.project, merged.project, [], latest.changeSerial)) {
      setError('工程在剪辑期间发生了修改，请重新应用剪辑。');
      return;
    }
    useEditor.getState().notify('节点剪辑已应用，可撤销。');
    onClose();
  };
  const requestClose = () => {
    setPlaying(false);
    if (changed) setConfirmClose(true);
    else onClose();
  };
  const px =
    clipDrag.current?.px ?? Math.max(0.05, (trackViewportWidth - 104) / (duration / 1000)) * zoom;
  const trackWidth = Math.max(trackViewportWidth - 104, (duration / 1000) * px);
  const rulerStep = duration <= 10000 ? 1 : Math.max(5, Math.ceil(duration / 1000 / 12 / 5) * 5);
  const overrun =
    (scene.choicesAtMs !== null && scene.choicesAtMs > duration) ||
    scene.events.some((e) => e.trigger === 'time' && e.atMs > duration);
  const activeVideo = videoAt(scene, position);
  const canSplit =
    !!activeVideo && position > activeVideo.startMs + 1 && position < activeVideo.endMs - 1;
  const split = () => {
    if (canSplit && activeVideo)
      command({
        action: 'split_video',
        clipId: activeVideo.clip.id,
        sourceMs: Math.round(activeVideo.sourceMs),
      });
  };
  const captureDrag = (e: PointerEvent<HTMLElement>, drag: ClipDrag) => {
    if (e.button !== 0 || busy || clipDrag.current) return false;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    clipDrag.current = { ...drag, base: draft, x: e.clientX, px };
    setPlaying(false);
    setDragging(true);
    return true;
  };
  const beginDrag = (
    e: PointerEvent<HTMLElement>,
    clip: VideoClip | AudioClip,
    mode: 'in' | 'out' | 'audio_move' | 'audio_end',
  ) => {
    if (captureDrag(e, { clip, mode })) setSelectedId(clip.id);
  };
  const durationHandle = (
    label: string,
    update: (project: Project, delta: number) => void,
    select: () => void,
  ) => (
    <span
      className="timeline-trim-handle out"
      title={label}
      onPointerDown={(e) => {
        if (captureDrag(e, { mode: 'duration', update })) select();
      }}
      onPointerMove={dragClip}
      onPointerUp={() => endDrag()}
      onPointerCancel={() => endDrag(true)}
      onLostPointerCapture={() => endDrag(true)}
      onClick={(e) => e.stopPropagation()}
    />
  );
  const updateStoryboardDuration = (project: Project, index: number, durationMs: number) => {
    const node = project.scenes.find((scene) => scene.id === nodeId)!;
    const pages = node.storyboardPages!;
    pages[index] = storyboardPagesSchema.element.parse({ ...pages[index], durationMs });
  };
  const storyboardClips = (pages: NonNullable<Scene['storyboardPages']>, overlay = false) =>
    pages.map((page, index) => {
      const selected = editingStoryboard && storyboardPageIndex === index;
      return (
        <button
          key={index}
          type="button"
          aria-label={`剧情文字第 ${index + 1} 页`}
          aria-pressed={selected}
          className={`timeline-clip ${selected ? 'selected' : ''}`}
          style={{ width: (page.durationMs / 1000) * px }}
          title={page.text}
          onClick={() => {
            setSelectedId('');
            setStoryboardPageIndex(index);
            setPreviewFrameKey(undefined);
            setPlaying(false);
            setPosition(pages.slice(0, index).reduce((sum, entry) => sum + entry.durationMs, 0));
          }}
        >
          <span className="timeline-clip-title">
            <FileText size={12} />
            <strong>第 {index + 1} 页</strong>
            <small>{(page.durationMs / 1000).toFixed(2)}s</small>
          </span>
          <span className="timeline-storyboard-excerpt">{page.text}</span>
          {!overlay &&
            durationHandle(
              '拖动调整剧情文字页时长',
              (next, delta) => {
                updateStoryboardDuration(
                  next,
                  index,
                  Math.max(1000, Math.min(60000, page.durationMs + delta)),
                );
              },
              () => {
                setSelectedId('');
                setStoryboardPageIndex(index);
              },
            )}
        </button>
      );
    });
  const dragClip = (e: PointerEvent<HTMLElement>) => {
    const drag = clipDrag.current;
    if (!drag) return;
    const delta = Math.round(((e.clientX - drag.x) / drag.px) * 100) * 10;
    if (Math.abs(e.clientX - drag.x) < 2 && !drag.last) return;
    const next = structuredClone(drag.base);
    try {
      if (drag.mode === 'duration') drag.update(next, delta);
      else applyMediaDrag(next, drag, delta);
      const previous = drag.base.scenes.find((scene) => scene.id === nodeId);
      const updated = next.scenes.find((scene) => scene.id === nodeId);
      drag.last = JSON.stringify(updated) === JSON.stringify(previous) ? undefined : next;
      setDraft(drag.last ?? drag.base);
      setError('');
      suppressClick.current = true;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const applyMediaDrag = (
    next: Project,
    drag: Exclude<ClipDrag, { mode: 'duration' }> & { px: number },
    delta: number,
  ) => {
    const clip = drag.clip;
    const sourceDuration =
      next.assets.find((a) => a.id === clip.assetId)?.durationMs || clip.trimEndMs;
    let input: TimelineCommand;
    if (drag.mode === 'audio_move' && 'startMs' in clip) {
      let startMs = Math.max(0, Math.min(duration - 10, clip.startMs + delta));
      if (snap) {
        const points = [0, scene.choicesAtMs ?? duration];
        let end = 0;
        for (const clip of stills) {
          end += clip.durationMs;
          points.push(end);
        }
        timeline.videoClips.forEach((c) => {
          end += c.trimEndMs - c.trimStartMs;
          points.push(end);
        });
        startMs =
          points.find((point) => (Math.abs(point - startMs) / 1000) * drag.px < 8) ?? startMs;
      }
      input = { action: 'update_audio', clipId: clip.id, patch: { startMs } };
    } else if (drag.mode === 'audio_end' && 'durationMs' in clip) {
      input = {
        action: 'update_audio',
        clipId: clip.id,
        patch: {
          durationMs: Math.max(
            10,
            Math.min(
              clip.durationMs + delta,
              clip.loop ? Math.max(10, duration - clip.startMs) : clip.trimEndMs - clip.trimStartMs,
            ),
          ),
        },
      };
    } else {
      input = {
        action: 'update_video',
        clipId: clip.id,
        patch:
          drag.mode === 'in'
            ? { trimStartMs: Math.max(0, Math.min(clip.trimEndMs - 10, clip.trimStartMs + delta)) }
            : {
                trimEndMs: Math.max(
                  clip.trimStartMs + 10,
                  Math.min(sourceDuration, clip.trimEndMs + delta),
                ),
              },
      };
    }
    editTimeline(next, nodeId, input);
  };
  const endDrag = (cancel = false) => {
    const drag = clipDrag.current;
    if (!drag) return;
    if (cancel) setDraft(drag.base);
    else if (drag.last) {
      setPast((rows) => [...rows, drag.base].slice(-60));
      setFuture([]);
    }
    clipDrag.current = null;
    setDragging(false);
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };
  const seekPointer = (e: PointerEvent<HTMLElement>) => {
    const bounds = tracksViewport.current
      ?.querySelector('.timeline-tracks')
      ?.getBoundingClientRect();
    if (!bounds) return;
    setPlaying(false);
    setPosition(Math.max(0, Math.min(duration, ((e.clientX - bounds.left - 100) / px) * 1000)));
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (inspectedShot && e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (previewFrame) setPreviewFrameKey(undefined);
        else setInspectedShotId(undefined);
        return;
      }
      if (
        busy ||
        confirmClose ||
        inspectedShotId ||
        (e.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')
      )
        return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.shiftKey ? redo() : undo();
      } else if (!mod && e.code === 'Space') {
        if ((e.target as HTMLElement).closest('.timeline-shot-list button')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        setPreviewFrameKey(undefined);
        if (position >= duration) setPosition(0);
        setPlaying((old) => !old);
      } else if (!mod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        e.stopImmediatePropagation();
        split();
      } else if (
        !mod &&
        ['Delete', 'Backspace'].includes(e.key) &&
        (selected || selectedId === selectedStill?.id)
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        command({ action: 'remove', clipId: selectedId });
      } else if (!mod && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPlaying(false);
        setPosition((old) =>
          Math.max(
            0,
            Math.min(duration, old + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1000 : 100)),
          ),
        );
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  return (
    <>
      <Modal
        open
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
        title={`节点时间线 · ${scene.title}`}
        className={`node-timeline-dialog ${dragging ? 'is-trimming' : ''}`}
      >
        <div className="timeline-toolbar">
          <div>
            <span className="timeline-workspace-label">
              <FilmStrip size={15} />
              剪辑工作台
            </span>
            <IconButton label="撤销剪辑" disabled={!past.length || busy} onClick={undo}>
              <ArrowCounterClockwise size={17} />
            </IconButton>
            <IconButton label="重做剪辑" disabled={!future.length || busy} onClick={redo}>
              <ArrowClockwise size={17} />
            </IconButton>
            <span>
              {pictureSummary} · {timeline.audioClips.length} 条音频
            </span>
          </div>
          <div>
            <span className="timeline-draft-status">{changed ? '剪辑草稿' : '已同步'}</span>
            <Button disabled={busy} onClick={requestClose}>
              返回蓝图
            </Button>
            <Button variant="primary" disabled={busy} onClick={apply}>
              应用剪辑
            </Button>
          </div>
        </div>
        <div className="timeline-editor-body">
          <aside className="timeline-bin" inert={busy || undefined}>
            {shots.length > 0 && (
              <>
                <div className="timeline-panel-heading">
                  <h3>分镜</h3>
                  <span>{shots.length}</span>
                </div>
                <div
                  className="timeline-bin-list timeline-shot-list"
                  role="group"
                  aria-label="分镜"
                >
                  {shots.map((shot) => {
                    const cover = shotFrames.find(({ shotId }) => shotId === shot.id);
                    return (
                      <button
                        key={shot.id}
                        type="button"
                        className="timeline-bin-asset"
                        aria-label={shot.label}
                        aria-description={cover ? undefined : '暂无画面'}
                        aria-pressed={inspectedShot?.id === shot.id}
                        onClick={() => {
                          setPlaying(false);
                          setPreviewFrameKey(undefined);
                          setInspectedShotId((current) =>
                            current === shot.id ? undefined : shot.id,
                          );
                        }}
                      >
                        <span className="timeline-bin-thumbnail">
                          {cover ? (
                            <img src={assetUrl(cover.asset, true)} alt="" loading="lazy" />
                          ) : (
                            <small>暂无画面</small>
                          )}
                        </span>
                        <span className="timeline-shot-label">{shot.label}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <div className="timeline-panel-heading">
              <h3>媒体素材</h3>
              <span>{mediaAssets.length}</span>
            </div>
            <Button className="full-width" busy={busy} onClick={() => void importAssets()}>
              <UploadSimple size={15} />
              {hasStills ? '导入图片 / 音频' : '导入视频 / 音频'}
            </Button>
            <div className="timeline-bin-search">
              <MagnifyingGlass size={14} />
              <input
                aria-label="搜索时间线素材"
                placeholder="搜索素材…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="timeline-media-filters" aria-label="素材类型">
              {(
                [
                  ['all', '全部'],
                  ...(!hasStills ? ([['video', '视频']] as const) : []),
                  ...(!hasVideo ? ([['image', '图片']] as const) : []),
                  ['audio', '音频'],
                ] as const
              ).map(([type, label]) => (
                <button
                  key={type}
                  aria-pressed={filter === type}
                  onClick={() => setMediaFilter(type)}
                >
                  {label}
                </button>
              ))}
            </div>
            {!hasVideo && pickedImages.length > 0 && (
              <Button
                className="full-width"
                onClick={() => {
                  if (command({ action: 'add_stills', assetIds: pickedImages }))
                    setPickedImages([]);
                }}
              >
                <Plus size={15} /> 排入所选图片（{pickedImages.length}）
              </Button>
            )}
            <div className="timeline-bin-list">
              {visibleAssets.map((a) =>
                a.type === 'image' ? (
                  <label key={a.id} className="timeline-image-pick">
                    <img src={assetUrl(a, !!a.thumbnail)} alt="" loading="lazy" />
                    <span title={a.name}>{a.name}</span>
                    <input
                      type="checkbox"
                      aria-label={`选择图片：${a.name}`}
                      checked={pickedImages.includes(a.id)}
                      onChange={(event) =>
                        setPickedImages((ids) =>
                          event.target.checked ? [...ids, a.id] : ids.filter((id) => id !== a.id),
                        )
                      }
                    />
                  </label>
                ) : (
                  <button
                    key={a.id}
                    className="timeline-bin-asset"
                    aria-label={`添加${a.type === 'audio' ? 'BGM' : '视频'}：${a.name}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/frameforge-asset', a.id);
                    }}
                    onClick={() =>
                      command({
                        action: 'add',
                        track: a.type === 'audio' ? 'audio' : 'video',
                        assetId: a.id,
                      })
                    }
                  >
                    <div className="timeline-bin-thumbnail">
                      {a.type === 'video' && a.thumbnail ? (
                        <img src={assetUrl(a, true)} alt="" />
                      ) : (
                        <MusicNotes size={24} />
                      )}
                      <span>{time(a.durationMs)}</span>
                      <Plus size={14} />
                    </div>
                    <span>
                      <strong>{a.name}</strong>
                      <small>
                        {a.type === 'audio' ? 'BGM' : '视频'} · {time(a.durationMs)}
                      </small>
                    </span>
                  </button>
                ),
              )}
              {!visibleAssets.length && (
                <div className="timeline-bin-empty">
                  <FilmStrip size={28} />
                  <span>{query ? '未找到匹配素材' : '暂无素材'}</span>
                </div>
              )}
            </div>
          </aside>
          <div className="timeline-viewer">
            <div className="timeline-viewer-heading">
              <strong>{previewFrame?.label ?? (inspectedShot ? '分镜详情' : '预览')}</strong>
              {inspectedShot && !previewFrame && (
                <button onClick={() => setInspectedShotId(undefined)}>返回剪辑预览</button>
              )}
              {previewFrame && (
                <>
                  <button onClick={() => setPreviewFrameKey(undefined)}>返回分镜详情</button>
                  <button
                    title={hasVideo ? '请先移除视频片段' : undefined}
                    disabled={hasVideo || busy}
                    onClick={() => {
                      if (
                        command({
                          action: 'append_shot_frame',
                          shotId: previewFrame.shotId,
                          frame: previewFrame.frame,
                        })
                      ) {
                        setPreviewFrameKey(undefined);
                        setInspectedShotId(undefined);
                      }
                    }}
                  >
                    加入图片轨
                  </button>
                </>
              )}
              <span>
                {draft.settings.width} × {draft.settings.height}
              </span>
              <span className="timeline-viewer-fit">适应窗口</span>
            </div>
            <div className="timeline-preview-stage">
              {previewFrame ? (
                <img
                  className="timeline-shot-preview"
                  src={assetUrl(previewFrame.asset)}
                  alt={previewFrame.label}
                />
              ) : inspectedShot ? (
                <ProductionShotDetails
                  key={inspectedShot.id}
                  project={draft}
                  shot={inspectedShot}
                  frames={shotFrames.filter(({ shotId }) => shotId === inspectedShot.id)}
                  onPreviewFrame={setPreviewFrameKey}
                />
              ) : (
                <TimelineMedia
                  project={draft}
                  scene={scene}
                  positionMs={position}
                  playing={playing && !busy && !confirmClose}
                  onPosition={setPosition}
                  onError={() => {
                    setPlaying(false);
                    setError('素材无法播放，请检查文件与媒体编码。');
                  }}
                  onBlocked={() => {
                    setPlaying(false);
                    setError('点击播放按钮继续预览。');
                  }}
                />
              )}
            </div>
            <div className="timeline-transport">
              <span className="timeline-current-time">
                {timecode(position)}
                <span> / {timecode(duration)}</span>
              </span>
              <div className="timeline-playback-buttons">
                <IconButton
                  label="回到片头"
                  onClick={() => {
                    setPlaying(false);
                    setPosition(0);
                  }}
                >
                  <SkipBack size={16} weight="fill" />
                </IconButton>
                <IconButton
                  label="后退 0.1 秒（←）"
                  onClick={() => {
                    setPlaying(false);
                    setPosition(Math.max(0, position - 100));
                  }}
                >
                  <ArrowLeft size={15} />
                </IconButton>
                <IconButton
                  label={playing ? '暂停剪辑预览' : '播放剪辑预览'}
                  onClick={() => {
                    setInspectedShotId(undefined);
                    setPreviewFrameKey(undefined);
                    if (position >= duration) setPosition(0);
                    setPlaying(!playing);
                  }}
                >
                  {playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
                </IconButton>
                <IconButton
                  label="前进 0.1 秒（→）"
                  onClick={() => {
                    setPlaying(false);
                    setPosition(Math.min(duration, position + 100));
                  }}
                >
                  <ArrowRight size={15} />
                </IconButton>
                <IconButton
                  label="跳至片尾"
                  onClick={() => {
                    setPlaying(false);
                    setPosition(duration);
                  }}
                >
                  <SkipForward size={16} weight="fill" />
                </IconButton>
              </div>
              <span className="timeline-playback-shortcut">Space 播放 / 暂停</span>
            </div>
            <input
              aria-label="剪辑预览进度"
              type="range"
              min="0"
              max={duration}
              step="10"
              value={position}
              onChange={(e) => {
                setPlaying(false);
                setPosition(Number(e.target.value));
              }}
            />
          </div>
          <aside
            className={`timeline-properties${hasStills && !audio ? ' timeline-properties-stills' : ''}`}
            inert={busy || undefined}
          >
            <div className="timeline-inspector-tabs">
              <span className="active">
                {audio ? '音频' : editingStoryboard ? '剧情文字' : hasStills ? '图片轨' : '视频'}
              </span>
              {(!hasStills || audio) && <span>片段属性</span>}
            </div>
            {(!hasStills || audio) && (
              <div className="timeline-panel-heading">
                <h3>
                  {audio
                    ? '音频设置'
                    : editingStoryboard
                      ? '剧情文字设置'
                      : hasStills
                        ? '图片片段设置'
                        : '视频片段设置'}
                </h3>
              </div>
            )}
            <div className="timeline-help" role="status">
              剧情文字 · {playerTextLabels[playerText.mode]}
              {playerText.effectiveDurationMs > 0 &&
                ' · ' + timecode(playerText.effectiveDurationMs)}
              {playerText.compressed && (
                <div>叠字已按画面时长缩短。原长 {timecode(playerText.authoredDurationMs)}。</div>
              )}
              {playerText.choiceBeforeTextEnd && <div>选项会在最后一页剧情文字结束前出现。</div>}
              {scene.choicesAtMs !== null && scene.choicesAtMs > duration && (
                <div>选项时点超出当前播放时长。</div>
              )}
              {scene.events.some((event) => event.trigger === 'time' && event.atMs > duration) && (
                <div>定时事件超出当前播放时长。</div>
              )}
              {selectedId && editableStoryboard && (
                <button type="button" onClick={() => setSelectedId('')}>
                  编辑剧情文字
                </button>
              )}
            </div>
            {!!scene.storyboardPages?.length && (
              <label className="timeline-storyboard-toggle">
                <input
                  type="checkbox"
                  checked={scene.storyboardOverlay ?? false}
                  onChange={(e) => {
                    setPreviewFrameKey(undefined);
                    patchScene({ storyboardOverlay: e.target.checked || undefined });
                  }}
                />
                在素材上显示剧情文字
              </label>
            )}
            {selected ? (
              <>
                <div className="timeline-selected-source">
                  {source?.thumbnail ? (
                    <img src={assetUrl(source, true)} alt="" />
                  ) : (
                    <MusicNotes size={22} />
                  )}
                  <strong className="timeline-source-name">
                    {source?.name}
                    <small>
                      {video
                        ? '主视频轨'
                        : audio?.role === 'dialogue'
                          ? '配音'
                          : audio?.role === 'effect'
                            ? '音效'
                            : '背景音乐'}
                    </small>
                  </strong>
                </div>
                <p className="timeline-help">
                  源素材长度 {((source?.durationMs ?? 0) / 1000).toFixed(2)} 秒
                </p>
                <Seconds
                  label="素材入点（秒）"
                  value={selected.trimStartMs}
                  onChange={(value) => {
                    if (value === null) return;
                    if (video)
                      command({
                        action: 'update_video',
                        clipId: video.id,
                        patch: { trimStartMs: value },
                      });
                    else if (audio)
                      command({
                        action: 'update_audio',
                        clipId: audio.id,
                        patch: {
                          trimStartMs: value,
                          durationMs: audio.loop
                            ? audio.durationMs
                            : Math.min(audio.durationMs, audio.trimEndMs - value),
                        },
                      });
                  }}
                />
                <Seconds
                  label="素材出点（秒）"
                  value={selected.trimEndMs}
                  onChange={(value) => {
                    if (value === null) return;
                    if (video)
                      command({
                        action: 'update_video',
                        clipId: video.id,
                        patch: { trimEndMs: value },
                      });
                    else if (audio)
                      command({
                        action: 'update_audio',
                        clipId: audio.id,
                        patch: {
                          trimEndMs: value,
                          durationMs: audio.loop
                            ? audio.durationMs
                            : Math.min(audio.durationMs, value - audio.trimStartMs),
                        },
                      });
                  }}
                />
                {audio && (
                  <>
                    <Field label="音频用途">
                      <select
                        value={audio.role ?? 'music'}
                        onChange={(event) => {
                          const role = event.target.value as AudioClip['role'];
                          command({ action: 'update_audio', clipId: audio.id, patch: { role } });
                        }}
                      >
                        <option value="music">背景音乐</option>
                        <option value="dialogue">配音</option>
                        <option value="effect">音效</option>
                      </select>
                    </Field>
                    <Seconds
                      label="BGM 开始时间（秒）"
                      value={audio.startMs}
                      onChange={(value) => {
                        if (value !== null)
                          command({
                            action: 'update_audio',
                            clipId: audio.id,
                            patch: { startMs: value },
                          });
                      }}
                    />
                    <Seconds
                      label="BGM 播放时长（秒）"
                      value={audio.durationMs}
                      onChange={(value) => {
                        if (value !== null)
                          command({
                            action: 'update_audio',
                            clipId: audio.id,
                            patch: { durationMs: value },
                          });
                      }}
                    />
                    <Seconds
                      label="音频淡入（秒）"
                      value={audio.fadeInMs ?? 0}
                      onChange={(value) => {
                        if (value !== null)
                          command({
                            action: 'update_audio',
                            clipId: audio.id,
                            patch: { fadeInMs: value },
                          });
                      }}
                    />
                    <Seconds
                      label="音频淡出（秒）"
                      value={audio.fadeOutMs ?? 0}
                      onChange={(value) => {
                        if (value !== null)
                          command({
                            action: 'update_audio',
                            clipId: audio.id,
                            patch: { fadeOutMs: value },
                          });
                      }}
                    />
                    <Field label="循环播放裁剪区">
                      <input
                        type="checkbox"
                        checked={audio.loop}
                        onChange={(e) =>
                          command({
                            action: 'update_audio',
                            clipId: audio.id,
                            patch: {
                              loop: e.target.checked,
                              durationMs: e.target.checked
                                ? audio.durationMs
                                : Math.min(audio.durationMs, audio.trimEndMs - audio.trimStartMs),
                            },
                          })
                        }
                      />
                    </Field>
                  </>
                )}
                <Field label={`音量 ${Math.round(selected.volume * 100)}%`}>
                  <input
                    aria-label="片段音量"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={selected.volume}
                    onChange={(e) =>
                      command(
                        video
                          ? {
                              action: 'update_video',
                              clipId: selected.id,
                              patch: { volume: Number(e.target.value) },
                            }
                          : {
                              action: 'update_audio',
                              clipId: selected.id,
                              patch: { volume: Number(e.target.value) },
                            },
                      )
                    }
                  />
                </Field>
                {video && (
                  <div className="timeline-order">
                    <Button
                      disabled={timeline.videoClips[0].id === video.id}
                      onClick={() =>
                        command({
                          action: 'move',
                          clipId: video.id,
                          index: timeline.videoClips.indexOf(video) - 1,
                        })
                      }
                    >
                      <ArrowLeft size={14} />
                      前移
                    </Button>
                    <Button
                      disabled={timeline.videoClips.at(-1)!.id === video.id}
                      onClick={() =>
                        command({
                          action: 'move',
                          clipId: video.id,
                          index: timeline.videoClips.indexOf(video) + 1,
                        })
                      }
                    >
                      后移
                      <ArrowRight size={14} />
                    </Button>
                  </div>
                )}
                <Button
                  variant="danger"
                  onClick={() => command({ action: 'remove', clipId: selected.id })}
                >
                  <Trash size={15} />
                  删除片段
                </Button>
              </>
            ) : editingStoryboard && editableStoryboard ? (
              <>
                {editableStoryboard.length > 1 && (
                  <Field label="剧情文字页">
                    <select
                      value={currentTextPage}
                      onChange={(event) => setStoryboardPageIndex(Number(event.target.value))}
                    >
                      {editableStoryboard.map((_, index) => (
                        <option key={index} value={index}>
                          第 {index + 1} 页
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <StoryboardPageFields
                  key={currentTextPage}
                  pages={editableStoryboard}
                  index={currentTextPage}
                  onChange={(storyboardPages) => patchScene({ storyboardPages })}
                />
              </>
            ) : (
              !hasStills && <p className="timeline-help">选择轨道中的片段，调整裁剪点和音量。</p>
            )}
            <div className="timeline-node-timing">
              {!hasVideo && !timeline.stillClips?.length && (
                <>
                  <Field label="静态画面">
                    <select
                      value={timeline.stillAssetId ?? ''}
                      onChange={(e) =>
                        command({ action: 'set_still', assetId: e.target.value || null })
                      }
                    >
                      <option value="">无静态画面</option>
                      {draft.assets
                        .filter((asset) => asset.type === 'image')
                        .map((asset) => (
                          <option key={asset.id} value={asset.id}>
                            {asset.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  {!storyboard && (
                    <Seconds
                      label={timeline.stillAssetId ? '画面时长（秒）' : '场景时长（秒）'}
                      value={duration}
                      onChange={(durationMs) => {
                        if (durationMs === null || durationMs === duration) return;
                        command({
                          action: 'set_still',
                          assetId: timeline.stillAssetId ?? null,
                          durationMs,
                        });
                      }}
                    />
                  )}
                </>
              )}
              {timeline.stillClips?.length && selectedStill && !editingStoryboard ? (
                <div className="timeline-still-settings">
                  <label className="timeline-still-picker" title={selectedStillAsset?.name}>
                    <span className="timeline-still-picker-preview" aria-hidden="true">
                      {selectedStillAsset && (
                        <img src={assetUrl(selectedStillAsset, true)} alt="" />
                      )}
                      <span className="timeline-still-picker-text">
                        <span>
                          图片 {selectedStillIndex + 1} / {stills.length}
                        </span>
                        <strong>{selectedStillAsset?.name ?? '图片'}</strong>
                      </span>
                      <CaretDown size={13} />
                    </span>
                    <select
                      aria-label="当前图片"
                      value={selectedStill.id}
                      onChange={(event) => setSelectedId(event.target.value)}
                    >
                      {stills.map((clip, index) => (
                        <option key={clip.id} value={clip.id}>
                          {index + 1}.{' '}
                          {draft.assets.find((asset) => asset.id === clip.assetId)?.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="timeline-still-fields">
                    <Seconds
                      label="图片时长（秒）"
                      value={selectedStill.durationMs}
                      onChange={(value) => {
                        if (value !== null && value !== selectedStill.durationMs)
                          command({
                            action: 'update_still',
                            clipId: selectedStill.id,
                            patch: { durationMs: value },
                          });
                      }}
                    />
                    {selectedStillIndex > 0 && (
                      <Field label="进入图片时">
                        <select
                          value={selectedStill.dissolveMs ?? 0}
                          onChange={(event) =>
                            command({
                              action: 'update_still',
                              clipId: selectedStill.id,
                              patch: { dissolveMs: Number(event.target.value) },
                            })
                          }
                        >
                          <option value={0}>硬切</option>
                          <option value={200}>叠化 0.2 秒</option>
                          <option value={350}>叠化 0.35 秒</option>
                          <option value={500}>叠化 0.5 秒</option>
                          {selectedStill.dissolveMs &&
                          ![200, 350, 500].includes(selectedStill.dissolveMs) ? (
                            <option value={selectedStill.dissolveMs}>
                              叠化 {selectedStill.dissolveMs / 1000} 秒
                            </option>
                          ) : null}
                        </select>
                      </Field>
                    )}
                  </div>
                  <div className="timeline-still-actions">
                    <Button
                      variant="ghost"
                      disabled={selectedStillIndex === 0}
                      onClick={() =>
                        command({
                          action: 'move',
                          clipId: selectedStill.id,
                          index: selectedStillIndex - 1,
                        })
                      }
                    >
                      <ArrowLeft size={14} /> 前移
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={selectedStillIndex === stills.length - 1}
                      onClick={() =>
                        command({
                          action: 'move',
                          clipId: selectedStill.id,
                          index: selectedStillIndex + 1,
                        })
                      }
                    >
                      后移 <ArrowRight size={14} />
                    </Button>
                    <IconButton
                      label="删除图片片段"
                      className="timeline-still-delete"
                      onClick={() => command({ action: 'remove', clipId: selectedStill.id })}
                    >
                      <Trash size={15} />
                    </IconButton>
                  </div>
                </div>
              ) : null}
              {hasStills && dialogueEnd > 0 && (
                <Button onClick={() => command({ action: 'align_stills_to_dialogue' })}>
                  对齐画面至配音结束
                </Button>
              )}
              <div className={hasStills ? 'timeline-still-interaction' : undefined}>
                {hasStills && <h4>节点交互</h4>}
                <StoryTimeInput
                  label="选择出现时间（秒）"
                  nullable
                  value={scene.choicesAtMs}
                  durationMs={duration}
                  onChange={(value) => patchScene({ choicesAtMs: value })}
                />
                {earlyChoice && (
                  <p className="timeline-help" role="status">
                    选项会在配音结束前出现。配音结束于 {timecode(dialogueEnd)}。
                  </p>
                )}
                {overrun && (
                  <>
                    <p className="timeline-help">存在超出片尾的交互或事件时间。</p>
                    <Button
                      onClick={() =>
                        patchScene({
                          choicesAtMs:
                            scene.choicesAtMs !== null && scene.choicesAtMs > duration
                              ? snapStoryTime(duration, duration)
                              : scene.choicesAtMs,
                          events: scene.events.map((e) =>
                            e.trigger === 'time' && e.atMs > duration
                              ? { ...e, atMs: snapStoryTime(duration, duration) }
                              : e,
                          ),
                        })
                      }
                    >
                      将超出时间移至片尾
                    </Button>
                  </>
                )}
              </div>
            </div>
          </aside>
        </div>
        <div
          className="timeline-height-handle"
          role="separator"
          tabIndex={0}
          aria-label="调整时间线高度"
          aria-orientation="horizontal"
          aria-valuemin={150}
          aria-valuemax={Math.floor(window.innerHeight * 0.5)}
          aria-valuenow={Math.round(trackHeight)}
          onDoubleClick={() => {
            setTrackHeight(window.innerHeight * 0.34);
            persistHeight(window.innerHeight * 0.34);
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            resizeDrag.current = { y: e.clientY, height: trackHeight, value: trackHeight };
          }}
          onPointerMove={(e) => {
            const drag = resizeDrag.current;
            if (!drag) return;
            drag.value = Math.max(
              150,
              Math.min(window.innerHeight * 0.5, drag.height + drag.y - e.clientY),
            );
            setTrackHeight(drag.value);
          }}
          onPointerUp={() => {
            if (resizeDrag.current) persistHeight(resizeDrag.current.value);
            resizeDrag.current = null;
          }}
          onPointerCancel={() => {
            if (resizeDrag.current) setTrackHeight(resizeDrag.current.height);
            resizeDrag.current = null;
          }}
          onKeyDown={(e) => {
            if (['ArrowUp', 'ArrowDown', 'Home'].includes(e.key)) {
              e.preventDefault();
              e.stopPropagation();
              const value =
                e.key === 'Home'
                  ? window.innerHeight * 0.34
                  : Math.max(
                      150,
                      Math.min(
                        window.innerHeight * 0.5,
                        trackHeight + (e.key === 'ArrowUp' ? 20 : -20),
                      ),
                    );
              setTrackHeight(value);
              persistHeight(value);
            }
          }}
        />
        <div className="timeline-track-toolbar">
          <div className="timeline-edit-tools">
            <IconButton label="选择工具" className="active" aria-pressed>
              <Cursor size={17} />
            </IconButton>
            <span className="timeline-tool-divider" />
            <IconButton label="分割片段（B）" disabled={!canSplit || busy} onClick={split}>
              <Scissors size={18} />
            </IconButton>
            <IconButton
              label="删除所选片段（Delete）"
              disabled={!selected || busy}
              onClick={() => selected && command({ action: 'remove', clipId: selected.id })}
            >
              <Trash size={17} />
            </IconButton>
            <span className="timeline-tool-divider" />
            <IconButton
              label="吸附"
              aria-pressed={snap}
              className={snap ? 'active' : ''}
              onClick={() => setSnap(!snap)}
            >
              <Magnet size={17} />
            </IconButton>
            <span className="timeline-toolbar-time">{timecode(position)}</span>
          </div>
          <div className="timeline-zoom-tools">
            <IconButton label="缩小时间线" onClick={() => setZoom(Math.max(0.4, zoom - 0.2))}>
              <Minus size={15} />
            </IconButton>
            <label>
              缩放
              <input
                aria-label="时间线缩放"
                type="range"
                min="0.4"
                max="3"
                step="0.1"
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
              />
            </label>
            <IconButton label="放大时间线" onClick={() => setZoom(Math.min(3, zoom + 0.2))}>
              <Plus size={15} />
            </IconButton>
            <IconButton label="适应时间线" onClick={() => setZoom(1)}>
              <CornersOut size={17} />
            </IconButton>
          </div>
        </div>
        <div
          ref={setTracksElement}
          className="timeline-tracks-scroll"
          style={{ height: trackHeight, maxHeight: '50dvh' }}
          inert={busy || undefined}
        >
          <div className="timeline-tracks" style={{ width: trackWidth + 100 }}>
            <div className="timeline-ruler">
              <span>轨道</span>
              <div
                style={{ width: trackWidth }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  seekPointer(e);
                }}
                onPointerMove={(e) => {
                  if (e.buttons === 1) seekPointer(e);
                }}
              >
                {Array.from(
                  { length: Math.min(101, Math.ceil(duration / 1000 / rulerStep) + 1) },
                  (_, i) => (
                    <button
                      key={i}
                      style={{ left: `${i * rulerStep * px}px` }}
                      onClick={() => {
                        setPlaying(false);
                        setPosition(Math.min(duration, i * rulerStep * 1000));
                      }}
                    >
                      {time(i * rulerStep * 1000)}
                    </button>
                  ),
                )}
              </div>
            </div>
            <div className="timeline-track-row">
              <span className="timeline-track-label">
                <span className="timeline-track-index">V1</span>
                <span>
                  {storyboard ? <FileText size={14} /> : <FilmStrip size={14} />}
                  {storyboard ? '剧情文字' : hasStills ? '图片轨' : '视频'}
                </span>
              </span>
              <div
                className="timeline-video-track"
                style={{ width: trackWidth }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const assetId = e.dataTransfer.getData('application/frameforge-asset');
                  if (assetId) command({ action: 'add', track: 'video', assetId });
                }}
              >
                {timeline.videoClips.map((clip, index) => (
                  <button
                    key={clip.id}
                    className={`timeline-clip video ${selectedId === clip.id ? 'selected' : ''}`}
                    style={{ width: ((clip.trimEndMs - clip.trimStartMs) / 1000) * px }}
                    aria-label={`视频片段 ${index + 1}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/frameforge-clip', clip.id);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      const clipId = e.dataTransfer.getData('application/frameforge-clip');
                      if (clipId) {
                        e.preventDefault();
                        e.stopPropagation();
                        command({ action: 'move', clipId, index });
                      }
                    }}
                    onClick={() => {
                      if (suppressClick.current) return;
                      setSelectedId(clip.id);
                      setPlaying(false);
                      setPosition(
                        timeline.videoClips
                          .slice(0, index)
                          .reduce((n, c) => n + c.trimEndMs - c.trimStartMs, 0),
                      );
                    }}
                  >
                    <span className="timeline-clip-title">
                      <FilmStrip size={12} />
                      <strong>{draft.assets.find((a) => a.id === clip.assetId)?.name}</strong>
                      <small>{((clip.trimEndMs - clip.trimStartMs) / 1000).toFixed(2)}s</small>
                    </span>
                    <ClipFilmstrip
                      asset={draft.assets.find((a) => a.id === clip.assetId)}
                      clip={clip}
                    />
                    <span
                      className="timeline-trim-handle in"
                      aria-label={`裁剪视频片段 ${index + 1} 入点`}
                      onPointerDown={(e) => beginDrag(e, clip, 'in')}
                      onPointerMove={dragClip}
                      onPointerUp={() => endDrag()}
                      onPointerCancel={() => endDrag(true)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span
                      className="timeline-trim-handle out"
                      aria-label={`裁剪视频片段 ${index + 1} 出点`}
                      onPointerDown={(e) => beginDrag(e, clip, 'out')}
                      onPointerMove={dragClip}
                      onPointerUp={() => endDrag()}
                      onPointerCancel={() => endDrag(true)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </button>
                ))}
                {stills.map((clip, index) => {
                  const asset = draft.assets.find((item) => item.id === clip.assetId);
                  return (
                    <button
                      key={clip.id}
                      aria-label={`图片 ${index + 1}：${asset?.name ?? ''}`}
                      className={`timeline-clip still ${selectedId === clip.id ? 'selected' : ''}`}
                      style={{ width: (clip.durationMs / 1000) * px }}
                      draggable
                      onDragStart={(event) => {
                        if (clipDrag.current) event.preventDefault();
                        else event.dataTransfer.setData('application/frameforge-clip', clip.id);
                      }}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        const clipId = event.dataTransfer.getData('application/frameforge-clip');
                        if (!clipId) return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (clipId !== clip.id) command({ action: 'move', clipId, index });
                      }}
                      onClick={() => {
                        setSelectedId(clip.id);
                        setPlaying(false);
                        setPosition(
                          stills
                            .slice(0, index)
                            .reduce((total, item) => total + item.durationMs, 0),
                        );
                      }}
                    >
                      <span className="timeline-clip-title">
                        <FilmStrip size={12} />
                        <strong>{asset?.name}</strong>
                        <small>{(clip.durationMs / 1000).toFixed(2)}s</small>
                      </span>
                      {asset && (
                        <img
                          src={assetUrl(asset, !!asset.thumbnail)}
                          alt=""
                          loading="lazy"
                          draggable={false}
                        />
                      )}
                      {durationHandle(
                        '拖动调整图片时长',
                        (next, delta) => {
                          const durationMs = Math.max(10, clip.durationMs + delta);
                          editTimeline(
                            next,
                            nodeId,
                            clip.id === 'still:single'
                              ? { action: 'set_still', assetId: clip.assetId, durationMs }
                              : { action: 'update_still', clipId: clip.id, patch: { durationMs } },
                          );
                        },
                        () => setSelectedId(clip.id),
                      )}
                    </button>
                  );
                })}
                {storyboard && storyboardClips(storyboard)}
                {!hasStills && !hasVideo && !storyboard && (
                  <span className="timeline-empty-track">添加视频或图片</span>
                )}
              </div>
            </div>
            {storyboardOverlay && (
              <div className="timeline-track-row">
                <span className="timeline-track-label">
                  <span className="timeline-track-index">T1</span>
                  <span>
                    <FileText size={14} />
                    剧情文字
                  </span>
                </span>
                <div className="timeline-video-track" style={{ width: trackWidth }}>
                  {storyboardClips(storyboardOverlay, true)}
                </div>
              </div>
            )}
            {timeline.audioClips.map((clip, index) => (
              <div className="timeline-track-row" key={clip.id}>
                <span className="timeline-track-label">
                  <span className="timeline-track-index">A{index + 1}</span>
                  <span>
                    <MusicNotes size={14} />
                    {clip.role === 'dialogue'
                      ? '配音'
                      : clip.role === 'effect'
                        ? '音效'
                        : 'BGM'}{' '}
                    {index + 1}
                  </span>
                </span>
                <div className="timeline-audio-track" style={{ width: trackWidth }}>
                  <button
                    className={`timeline-clip audio ${selectedId === clip.id ? 'selected' : ''}`}
                    aria-label={`BGM 片段 ${index + 1}`}
                    style={{
                      left: (clip.startMs / 1000) * px,
                      width: Math.max(
                        1,
                        (Math.min(clip.durationMs, Math.max(0, duration - clip.startMs)) / 1000) *
                          px,
                      ),
                    }}
                    onClick={() => {
                      if (suppressClick.current) return;
                      setSelectedId(clip.id);
                      setPlaying(false);
                      setPosition(Math.min(duration, clip.startMs));
                    }}
                    onPointerDown={(e) => beginDrag(e, clip, 'audio_move')}
                    onPointerMove={dragClip}
                    onPointerUp={() => endDrag()}
                    onPointerCancel={() => endDrag(true)}
                  >
                    <span className="timeline-clip-title">
                      <MusicNotes size={13} />
                      <strong>{draft.assets.find((a) => a.id === clip.assetId)?.name}</strong>
                      <small>
                        {clip.loop ? '循环 · ' : ''}
                        {Math.round(clip.volume * 100)}%
                      </small>
                    </span>
                    <span className="timeline-audio-band">
                      <ClipWaveform
                        asset={draft.assets.find((a) => a.id === clip.assetId)}
                        clip={clip}
                        visibleMs={Math.min(clip.durationMs, Math.max(0, duration - clip.startMs))}
                      />
                    </span>
                    <span
                      className="timeline-trim-handle out"
                      aria-label={`调整 BGM ${index + 1} 播放长度`}
                      onPointerDown={(e) => beginDrag(e, clip, 'audio_end')}
                      onPointerMove={dragClip}
                      onPointerUp={() => endDrag()}
                      onPointerCancel={() => endDrag(true)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </button>
                </div>
              </div>
            ))}
            {!timeline.audioClips.length && (
              <div className="timeline-track-row">
                <span className="timeline-track-label">
                  <span className="timeline-track-index">A1</span>
                  <span>
                    <MusicNotes size={14} />
                    BGM
                  </span>
                </span>
                <div
                  className="timeline-audio-track"
                  style={{ width: trackWidth }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const assetId = e.dataTransfer.getData('application/frameforge-asset');
                    if (assetId) command({ action: 'add', track: 'audio', assetId });
                  }}
                >
                  <span className="timeline-empty-track">添加音频作为背景音乐</span>
                </div>
              </div>
            )}
            {scene.choices.length > 0 && (
              <button
                className="timeline-interaction-marker"
                aria-label="定位选项时间"
                title={`选择 · ${timecode(scene.choicesAtMs ?? duration)}`}
                style={{ left: 100 + ((scene.choicesAtMs ?? duration) / 1000) * px }}
                onClick={() => {
                  setPlaying(false);
                  setPosition(Math.min(duration, scene.choicesAtMs ?? duration));
                }}
              >
                <GitBranch size={12} />
              </button>
            )}
            {scene.events
              .filter((e) => e.trigger === 'time')
              .map((event) => (
                <button
                  key={event.id}
                  className="timeline-event-marker"
                  title={`${event.name} · ${timecode(event.atMs)}`}
                  aria-label={`定位事件：${event.name}`}
                  style={{ left: 100 + (event.atMs / 1000) * px }}
                  onClick={() => {
                    setPlaying(false);
                    setPosition(Math.min(duration, event.atMs));
                  }}
                >
                  <Lightning size={10} />
                </button>
              ))}
            <div
              className="timeline-playhead"
              role="slider"
              tabIndex={0}
              aria-label="时间线播放头"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={Math.round(position)}
              style={{ left: 100 + (position / 1000) * px }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                seekPointer(e);
              }}
              onPointerMove={(e) => {
                if (e.buttons === 1) seekPointer(e);
              }}
            />
          </div>
        </div>
        <div className="timeline-footer">
          <span role={error ? 'alert' : undefined}>
            {error ||
              `${pictureSummary} · ${timeline.audioClips.length} 条音频 · 总时长 ${timecode(duration)}`}
          </span>
          <span>Space 播放　B 分割　Delete 删除　Ctrl Z 撤销</span>
        </div>
      </Modal>
      <Modal open={confirmClose} onOpenChange={setConfirmClose} title="离开节点时间线？">
        <p>当前剪辑尚未应用到工程。</p>
        <div className="dialog-actions">
          <Button onClick={() => setConfirmClose(false)}>继续编辑</Button>
          <Button variant="danger" onClick={onClose}>
            放弃剪辑
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setConfirmClose(false);
              apply();
            }}
          >
            应用并返回
          </Button>
        </div>
      </Modal>
    </>
  );
}
