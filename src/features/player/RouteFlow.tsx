import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Flag,
  Trophy,
  GitBranch,
  CircleHelp,
  Plus,
  Minus,
  Maximize as CornersOut,
  Crosshair,
} from 'lucide-react';
import { type Project } from '../../../packages/domain/schema';
import type { RuntimeState } from '../../../packages/runtime/engine';
import { IconButton } from '../../components/ui';
import { buildRouteGraph, ROUTE_NODE_HEIGHT, ROUTE_NODE_WIDTH } from './route-graph';

export function RouteOverview({ project: p, state }: { project: Project; state: RuntimeState }) {
  const [chapter, setChapter] = useState(() =>
    p.scenes.length > 80
      ? (p.scenes.find((scene) => scene.id === state.nodeId)?.chapterId ?? '')
      : '',
  );
  const graph = useMemo(() => buildRouteGraph(p, state, chapter), [p, state, chapter]);
  const visited = new Set([...state.visited, state.nodeId]);
  const knownChapters = new Set(p.scenes.filter((s) => visited.has(s.id)).map((s) => s.chapterId));
  const chapterName = (id: string) =>
    knownChapters.has(id)
      ? (p.chapters.find((c) => c.id === id)?.title ?? '已探索章节')
      : '未知章节';
  const hasPreviews = graph.nodes.some((node) => node.preview);
  const viewport = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const viewMode = useRef<'auto' | 'fit' | 'manual'>('auto');
  const drag = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const marker = useId().replace(/:/g, '');
  const frameHeight = useCallback((element: HTMLDivElement) => {
    const overlay = footer.current;
    return Math.max(1, overlay ? overlay.offsetTop : element.clientHeight);
  }, []);
  const frameGraph = useCallback(
    (readable: boolean) => {
      const element = viewport.current;
      if (!element) return;
      const height = frameHeight(element);
      const fitted = Math.min(
        1,
        Math.max(
          0.001,
          Math.min((element.clientWidth - 48) / graph.width, (height - 36) / graph.height),
        ),
      );
      const scale = readable ? Math.max(0.8, fitted) : fitted;
      const focal =
        graph.nodes.find((node) => node.scene.id === state.nodeId) ??
        graph.nodes.find((node) => !node.external && !node.preview) ??
        graph.nodes[0];
      setView(
        scale > fitted && focal
          ? {
              scale,
              x: element.clientWidth / 2 - (focal.x + ROUTE_NODE_WIDTH / 2) * scale,
              y: height / 2 - (focal.y + ROUTE_NODE_HEIGHT / 2) * scale,
            }
          : {
              scale,
              x: (element.clientWidth - graph.width * scale) / 2,
              y: (height - graph.height * scale) / 2,
            },
      );
    },
    [frameHeight, graph, state.nodeId],
  );
  const fit = useCallback(() => {
    viewMode.current = 'fit';
    frameGraph(false);
  }, [frameGraph]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    viewMode.current = 'auto';
    const resize = () => {
      if (viewMode.current !== 'manual') frameGraph(viewMode.current === 'auto');
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    if (footer.current) observer.observe(footer.current);
    resize();
    return () => observer.disconnect();
  }, [frameGraph]);
  const zoom = useCallback(
    (factor: number, anchor?: { x: number; y: number }) => {
      const element = viewport.current;
      if (!element) return;
      viewMode.current = 'manual';
      setView((old) => {
        const scale = Math.min(2, Math.max(0.001, old.scale * factor));
        const point = anchor ?? { x: element.clientWidth / 2, y: frameHeight(element) / 2 };
        return {
          scale,
          x: point.x - ((point.x - old.x) * scale) / old.scale,
          y: point.y - ((point.y - old.y) * scale) / old.scale,
        };
      });
    },
    [frameHeight],
  );
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest('.route-graph-tools')) return;
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      zoom(Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * 0.002), {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [zoom]);
  const locate = () => {
    const node = graph.nodes.find((n) => n.scene.id === state.nodeId);
    const element = viewport.current;
    if (!node || !element) return;
    viewMode.current = 'manual';
    const scale = Math.max(0.8, viewRef.current.scale);
    setView({
      scale,
      x: element.clientWidth / 2 - (node.x + ROUTE_NODE_WIDTH / 2) * scale,
      y: frameHeight(element) / 2 - (node.y + ROUTE_NODE_HEIGHT / 2) * scale,
    });
  };
  return (
    <div className="route-overview">
      <div className="route-summary">
        <strong>已探索 {p.scenes.filter((s) => visited.has(s.id)).length} 个节点</strong>
        <select aria-label="路线章节" value={chapter} onChange={(e) => setChapter(e.target.value)}>
          <option value="">全部章节</option>
          {p.chapters
            .filter((c) => knownChapters.has(c.id))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {chapterName(c.id)}
              </option>
            ))}
        </select>
      </div>
      <div
        ref={viewport}
        className={`route-graph-viewport ${dragging ? 'dragging' : ''}`}
        role="region"
        aria-label="剧情流程图"
        tabIndex={0}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as Element).closest('.route-graph-tools')) return;
          viewMode.current = 'manual';
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, viewX: view.x, viewY: view.y };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const start = drag.current;
          if (start)
            setView((old) => ({
              ...old,
              x: start.viewX + e.clientX - start.x,
              y: start.viewY + e.clientY - start.y,
            }));
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
            e.preventDefault();
            viewMode.current = 'manual';
            setView((old) => ({
              ...old,
              x: old.x + (e.key === 'ArrowLeft' ? 60 : e.key === 'ArrowRight' ? -60 : 0),
              y: old.y + (e.key === 'ArrowUp' ? 60 : e.key === 'ArrowDown' ? -60 : 0),
            }));
          }
          if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            zoom(1.2);
          }
          if (e.key === '-') {
            e.preventDefault();
            zoom(1 / 1.2);
          }
          if (e.key === '0') {
            e.preventDefault();
            fit();
          }
        }}
      >
        {!graph.nodes.length && <div className="route-graph-empty">本章暂无剧情</div>}
        <div
          className="route-graph-world"
          style={{
            width: graph.width,
            height: graph.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          <svg
            width={graph.width}
            height={graph.height}
            className="route-graph-connections"
            role="img"
            aria-label="剧情连线"
          >
            <defs>
              <marker
                id={marker}
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" fill="#999" />
              </marker>
            </defs>
            {graph.edges.map((edge) => (
              <path
                key={edge.id}
                className={`route-graph-edge ${edge.preview ? 'preview' : ''}`}
                data-source={edge.source}
                data-target={edge.target}
                d={edge.path}
                markerEnd={`url(#${marker})`}
              />
            ))}
          </svg>
          {graph.nodes.map(({ scene, x, y, external, preview }) => {
            const Icon = preview
              ? CircleHelp
              : scene.kind === 'ending'
                ? Trophy
                : scene.kind === 'branch'
                  ? GitBranch
                  : Flag;
            return (
              <article
                className={`route-graph-node ${preview ? 'preview' : 'visited'} ${scene.id === state.nodeId ? 'current' : ''} ${external ? 'external' : ''}`}
                key={scene.id}
                data-node-id={scene.id}
                style={{ left: x, top: y, width: ROUTE_NODE_WIDTH, height: ROUTE_NODE_HEIGHT }}
              >
                <div className="route-chapter-title">
                  <Icon size={13} />
                  <span>{chapterName(scene.chapterId)}</span>
                  {external && <small>跨章</small>}
                </div>
                <strong title={scene.title}>{scene.title}</strong>
                <span className="route-node-status">
                  {preview ? '未选择此路线' : scene.id === state.nodeId ? '当前节点' : '本局已到达'}
                  {scene.kind === 'ending' ? ' · 结局' : ''}
                </span>
                <i className="route-port input" />
                {!preview && <i className="route-port output" />}
              </article>
            );
          })}
        </div>
        <div ref={footer} className="route-graph-footer">
          <div className="route-legend" role="group" aria-label="路线图例">
            <span className="legend-current">当前节点</span>
            <span className="legend-visited">已到达</span>
            <span className="legend-taken">已走路线</span>
            {hasPreviews && <span className="legend-preview">未选路线 · 仅预览一步</span>}
          </div>
          <div className="route-graph-tools">
            <IconButton label="缩小路线图" onClick={() => zoom(1 / 1.2)}>
              <Minus size={16} />
            </IconButton>
            <span>
              {view.scale < 0.01 ? (view.scale * 100).toFixed(1) : Math.round(view.scale * 100)}%
            </span>
            <IconButton label="放大路线图" onClick={() => zoom(1.2)}>
              <Plus size={16} />
            </IconButton>
            <IconButton label="适应路线图" onClick={fit}>
              <CornersOut size={17} />
            </IconButton>
            <IconButton
              label="定位当前节点"
              onClick={locate}
              disabled={!graph.nodes.some((n) => n.scene.id === state.nodeId)}
            >
              <Crosshair size={17} />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
}
