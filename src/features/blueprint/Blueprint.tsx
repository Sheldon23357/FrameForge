import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  useReactFlow,
  applyNodeChanges,
  getNodesBounds,
  MarkerType,
  ViewportPortal,
  type Connection,
  type NodeChange,
  type NodePositionChange,
  type Edge,
} from '@xyflow/react';
import {
  Plus,
  Minus,
  CornersOut,
  TreeStructure,
  FilmStrip,
  GitBranch,
  Trophy,
  Hand,
  Cursor,
  MagnifyingGlass,
  CaretDown,
  Magnet,
} from '@phosphor-icons/react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { useEditor } from '../../store/editor';
import { useAgent } from '../../store/agent';
import { StoryNode, type StoryFlowNode } from './StoryNode';
import { Button, IconButton } from '../../components/ui';
import { GRID_SIZE, SNAP_GRID, snapToNodes, type AlignmentGuide } from './snapping';
import { chapterTitle } from '../../../packages/domain/schema';
import { arrangeBlueprint } from '../../../packages/domain/blueprint-layout';
import { previewProjectEdits } from '../../../packages/domain/project-merge';
import { openNodeTimeline } from '../timeline/TimelineEditor';
const nodeTypes = { story: StoryNode };
const edgeOptions = { type: 'default', pathOptions: { curvature: 0.45 }, interactionWidth: 28 };
function Canvas() {
  const p = useEditor((s) => s.project);
  const agentDraft = useAgent((s) => s.blueprintDraft);
  const graph = useMemo(
    () => (agentDraft && previewProjectEdits(agentDraft.base, p, agentDraft.draft)) || p,
    [agentDraft, p],
  );
  const draftIds = useMemo(() => {
    if (graph === p) return new Set<string>();
    const committedScenes = new Map(p.scenes.map((scene) => [scene.id, JSON.stringify(scene)]));
    return new Set(
      graph.scenes
        .filter(
          (scene) =>
            committedScenes.get(scene.id) !== JSON.stringify(scene) ||
            graph.layout[scene.id]?.x !== p.layout[scene.id]?.x ||
            graph.layout[scene.id]?.y !== p.layout[scene.id]?.y,
        )
        .map(({ id }) => id),
    );
  }, [graph, p]);
  const activeChapterId = useEditor((s) => s.activeChapterId);
  const visibleScenes = useMemo(
    () => graph.scenes.filter((s) => !activeChapterId || s.chapterId === activeChapterId),
    [graph, activeChapterId],
  );
  const visibleIds = useMemo(() => new Set(visibleScenes.map((s) => s.id)), [visibleScenes]);
  const selected = useEditor((s) => s.selectedIds);
  const search = useEditor((s) => s.search);
  const focus = useEditor((s) => s.focusNodeId);
  const draggedAssetId = useEditor((s) => s.draggedAssetId);
  const flow = useReactFlow<StoryFlowNode>();
  const [nodes, setNodes] = useState<StoryFlowNode[]>(() =>
    visibleScenes.map((scene) => {
      const draft = draftIds.has(scene.id);
      return {
        id: scene.id,
        type: 'story',
        position: graph.layout[scene.id] ?? { x: 0, y: 0 },
        data: { scene, project: graph, draft },
        selected: !draft && selected.includes(scene.id),
        draggable: !draft,
        selectable: !draft,
        connectable: !draft,
        deletable: !draft,
        focusable: !draft,
      };
    }),
  );
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(false);
  const [map, setMap] = useState(true);
  const [selectedEdges, setSelectedEdges] = useState<string[]>([]);
  const [snap, setSnap] = useState(
    () => localStorage.getItem('frameforge.blueprint.snap') !== 'false',
  );
  const [guides, setGuides] = useState<AlignmentGuide[]>([]);
  useEffect(() => {
    localStorage.setItem('frameforge.blueprint.snap', String(snap));
  }, [snap]);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    position: { x: number; y: number };
  } | null>(null);
  const initialized = useRef(false);
  const projectId = useRef(p.id);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useEffect(() => {
    setNodes((previous) => {
      const byId = new Map(previous.map((node) => [node.id, node]));
      const selectedIds = new Set(selected);
      return visibleScenes.map((scene) => {
        const node = byId.get(scene.id);
        const position = graph.layout[scene.id] ?? { x: 0, y: 0 };
        const draft = draftIds.has(scene.id);
        const isSelected = !draft && selectedIds.has(scene.id);
        const className =
          search && !`${scene.title} ${scene.notes} ${scene.endingText}`.includes(search)
            ? 'search-dimmed'
            : '';
        const data =
          node?.data.project === graph && node.data.scene === scene && node.data.draft === draft
            ? node.data
            : { scene, project: graph, draft };
        if (
          node &&
          node.data === data &&
          node.position.x === position.x &&
          node.position.y === position.y &&
          node.selected === isSelected &&
          (node.className ?? '') === className
        )
          return node;
        return {
          ...node,
          id: scene.id,
          type: 'story',
          position,
          data,
          selected: isSelected,
          className,
          draggable: !draft,
          selectable: !draft,
          connectable: !draft,
          deletable: !draft,
          focusable: !draft,
        };
      });
    });
    if (initialized.current && projectId.current !== p.id) {
      projectId.current = p.id;
      setTimeout(() => flow.fitView({ padding: 0.15, duration: 300 }), 100);
    }
  }, [p, graph, draftIds, visibleScenes, selected, search, flow]);
  useEffect(() => {
    setSelectedEdges([]);
    setGuides([]);
    setMenu(null);
    const timer = !focus
      ? setTimeout(() => flow.fitView({ padding: 0.18, maxZoom: 0.85, duration: 300 }), 100)
      : undefined;
    return () => clearTimeout(timer);
  }, [activeChapterId, flow]);
  useEffect(() => {
    if (focus) {
      setTimeout(
        () => flow.fitView({ nodes: [{ id: focus }], maxZoom: 0.95, padding: 0.6, duration: 350 }),
        40,
      );
      useEditor.setState({ focusNodeId: undefined });
    }
  }, [focus, flow]);
  const visibleDrafts = useMemo(
    () => visibleScenes.filter(({ id }) => draftIds.has(id)),
    [visibleScenes, draftIds],
  );
  const fitDraft = useCallback(
    (wholeChapter = false) => {
      if (!visibleDrafts.length) return;
      const bounds = getNodesBounds(
        (wholeChapter && visibleScenes.length <= 20 ? visibleScenes : visibleDrafts).map(
          (scene) => {
            const measured = flow.getNode(scene.id)?.measured;
            return {
              id: scene.id,
              data: {},
              position: graph.layout[scene.id] ?? { x: 0, y: 0 },
              // Draft nodes can be outside the viewport and have no measured size yet.
              width: measured?.width ?? 254,
              height:
                measured?.height ??
                (scene.kind === 'branch' ? 120 : 260) + scene.choices.length * 30,
            };
          },
        ),
      );
      void flow.fitBounds(bounds, { padding: 0.25, duration: 250 });
    },
    [visibleDrafts, visibleScenes, graph, flow],
  );
  const fittedDraft = useRef(false);
  useEffect(() => {
    if (!visibleDrafts.length) fittedDraft.current = false;
    else if (!fittedDraft.current && !nodesRef.current.some(({ dragging }) => dragging)) {
      fittedDraft.current = true;
      fitDraft(true);
    }
  }, [visibleDrafts, fitDraft]);
  const edges = useMemo(
    () =>
      visibleScenes.flatMap((s) => {
        const out: Edge[] = [];
        if (s.kind === 'ending') return [];
        for (const c of s.choices)
          if (c.targetId)
            out.push({
              id: c.id,
              source: s.id,
              sourceHandle: c.id,
              target: c.targetId,
              type: 'default',
              markerEnd: { type: MarkerType.ArrowClosed, width: 8, height: 8 },
              className: s.kind === 'branch' ? 'branch-edge' : '',
              style: { stroke: s.kind === 'branch' ? '#a3a3a3' : '#8e8e8e', strokeWidth: 3 },
            });
        if (s.kind === 'video' && !s.choices.length && s.nextId)
          out.push({
            id: `next:${s.id}`,
            source: s.id,
            sourceHandle: 'next',
            target: s.nextId,
            markerEnd: { type: MarkerType.ArrowClosed, width: 8, height: 8 },
            style: { stroke: '#8e8e8e', strokeWidth: 3 },
          });
        return out
          .filter((edge) => visibleIds.has(edge.target))
          .map((edge) => {
            const draft = draftIds.has(edge.source) || draftIds.has(edge.target);
            const targetChapter = graph.scenes.find(({ id }) => id === edge.target)!.chapterId;
            return {
              ...edge,
              className: [edge.className, draft && 'agent-draft-edge'].filter(Boolean).join(' '),
              style: draft ? { ...edge.style, stroke: '#b39a68' } : edge.style,
              label:
                targetChapter !== s.chapterId
                  ? `跨章 → ${chapterTitle(graph, targetChapter)}`
                  : undefined,
              labelStyle: { fill: '#e0e0e0', fontSize: 11 },
              labelBgStyle: { fill: '#292929' },
              selected: !draft && selectedEdges.includes(edge.id),
              selectable: !draft,
              deletable: !draft,
              focusable: !draft,
              reconnectable: draft ? false : ('target' as const),
            };
          });
      }),
    [graph, draftIds, visibleScenes, visibleIds, selectedEdges],
  );
  const connect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || draftIds.has(c.source) || draftIds.has(c.target)) return;
      useEditor.getState().commit((p) => {
        const s = p.scenes.find((s) => s.id === c.source);
        if (!s || !p.scenes.some(({ id }) => id === c.target)) return;
        if (c.sourceHandle === 'next') s.nextId = c.target!;
        else {
          const choice = s.choices.find((x) => x.id === c.sourceHandle);
          if (choice) choice.targetId = c.target!;
        }
      });
    },
    [draftIds],
  );
  const nodesChanged = useCallback(
    (changes: NodeChange<StoryFlowNode>[]) => {
      let next = applyNodeChanges(changes, nodesRef.current);
      const moved = changes.filter(
        (c): c is NodePositionChange => c.type === 'position' && !!c.position,
      );
      const moving = next.find((n) => n.id === moved[0]?.id);
      if (snap && moving) {
        const excluded = new Set(moved.map((c) => c.id));
        const aligned = snapToNodes(
          moving,
          next.filter(({ data }) => !data.draft),
          excluded,
          8 / flow.getZoom(),
        );
        next = next.map((n) =>
          excluded.has(n.id)
            ? { ...n, position: { x: n.position.x + aligned.dx, y: n.position.y + aligned.dy } }
            : n,
        );
        setGuides(moved.some((c) => c.dragging) ? aligned.guides : []);
      } else setGuides((previous) => (previous.length ? [] : previous));
      nodesRef.current = next;
      setNodes(next);
      if (changes.some((c) => c.type === 'select')) {
        const ids = next.filter((n) => n.selected).map((n) => n.id);
        if (ids.join(',') !== useEditor.getState().selectedIds.join(','))
          useEditor.getState().select(ids);
      }
    },
    [snap, flow],
  );
  const autoLayout = () => {
    useEditor
      .getState()
      .commit(
        (draft) => Object.assign(draft.layout, arrangeBlueprint(draft, activeChapterId)),
        undefined,
        '自动整理蓝图',
      );
    setTimeout(() => flow.fitView({ padding: 0.16, duration: 400 }), 100);
  };
  const add = (kind: 'video' | 'branch' | 'ending') => {
    const position =
      menu?.position ??
      flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    useEditor.getState().addScene(kind, position);
    setMenu(null);
  };
  return (
    <div
      className={`blueprint ${draggedAssetId ? 'asset-dragging' : ''}`}
      onClick={() => menu && setMenu(null)}
    >
      <div className="canvas-heading">
        {!!visibleDrafts.length && (
          <Button
            className="small agent-draft-control"
            title="定位未提交的节点和连线"
            onClick={() => fitDraft()}
          >
            Agent 草稿 · {visibleDrafts.length}
          </Button>
        )}
        {activeChapterId && (
          <Button
            className="small"
            disabled={!p.chapters.find((c) => c.id === activeChapterId)?.startNodeId}
            onClick={() =>
              useEditor.setState({
                playing: true,
                playFrom: p.chapters.find((c) => c.id === activeChapterId)?.startNodeId,
              })
            }
          >
            试玩本章
          </Button>
        )}
        <Dropdown.Root>
          <Dropdown.Trigger asChild>
            <Button className="small">
              <Plus size={15} />
              添加节点
              <CaretDown size={11} />
            </Button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className="dropdown-content" sideOffset={8} align="end">
              <Dropdown.Item onSelect={() => add('video')}>
                <FilmStrip />
                视频片段<span>V</span>
              </Dropdown.Item>
              <Dropdown.Item onSelect={() => add('branch')}>
                <GitBranch />
                条件分支<span>B</span>
              </Dropdown.Item>
              <Dropdown.Item onSelect={() => add('ending')}>
                <Trophy />
                故事结局<span>E</span>
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </div>
      {!visibleScenes.length && (
        <div className="chapter-canvas-empty">
          <FilmStrip size={30} weight="thin" />
          <span>本章暂无节点</span>
          <Button onClick={() => add('video')}>
            <Plus size={14} />
            添加节点
          </Button>
        </div>
      )}
      <ReactFlow<StoryFlowNode>
        nodes={nodes}
        edges={edges}
        onlyRenderVisibleElements
        nodeTypes={nodeTypes}
        defaultMarkerColor="#c2c2c2"
        defaultEdgeOptions={edgeOptions}
        connectionLineStyle={{ stroke: '#cacaca', strokeWidth: 3, strokeLinecap: 'round' }}
        connectionRadius={snap ? 40 : 20}
        snapToGrid={snap}
        snapGrid={SNAP_GRID}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 0.85 }}
        minZoom={0.15}
        maxZoom={1.6}
        onInit={() => {
          initialized.current = true;
        }}
        onMove={(_, v) => setZoom(v.zoom)}
        onNodesChange={nodesChanged}
        onEdgesChange={(changes) =>
          setSelectedEdges((old) => {
            let next = [...old];
            for (const c of changes)
              if (c.type === 'select')
                next = c.selected
                  ? [...new Set([...next, c.id])]
                  : next.filter((id) => id !== c.id);
            return next;
          })
        }
        onNodeDragStop={(_, __, moved) => {
          setGuides([]);
          useEditor.getState().commit((p) =>
            moved
              .filter(({ data }) => !data.draft)
              .forEach((n) => {
                if (!p.scenes.some(({ id }) => id === n.id)) return;
                p.layout[n.id] =
                  nodesRef.current.find((current) => current.id === n.id)?.position ?? n.position;
              }),
          );
        }}
        onConnect={connect}
        onReconnect={(edge, c) =>
          connect({ ...c, source: edge.source, sourceHandle: edge.sourceHandle ?? null })
        }
        isValidConnection={(c) => {
          if (draftIds.has(c.source) || draftIds.has(c.target)) return false;
          const source = p.scenes.find((s) => s.id === c.source);
          return c.target !== c.source || source?.kind !== 'branch';
        }}
        onEdgesDelete={(edges) =>
          useEditor.getState().commit((p) => {
            for (const edge of edges) {
              if (edge.deletable === false) continue;
              const s = p.scenes.find((s) => s.id === edge.source);
              if (!s) continue;
              if (edge.sourceHandle === 'next') s.nextId = '';
              else {
                const c = s.choices.find((c) => c.id === edge.sourceHandle);
                if (c) c.targetId = '';
              }
            }
          })
        }
        onNodesDelete={(nodes) =>
          useEditor
            .getState()
            .deleteScenes(nodes.filter(({ data }) => !data.draft).map((n) => n.id))
        }
        onPaneContextMenu={(e) => {
          e.preventDefault();
          setMenu({
            x: e.clientX,
            y: e.clientY,
            position: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
          });
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(e) => {
          e.preventDefault();
          const assetId = e.dataTransfer.getData('application/frameforge-asset');
          if (p.assets.find((a) => a.id === assetId)?.type === 'audio') {
            useEditor.getState().notify('请进入视频节点时间线添加 BGM。');
            return;
          }
          if (assetId)
            useEditor
              .getState()
              .addScene(
                'video',
                flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
                assetId,
              );
        }}
        panOnDrag={pan ? true : [1, 2]}
        selectionOnDrag={!pan}
        selectionKeyCode="Shift"
        multiSelectionKeyCode="Shift"
        panActivationKeyCode="Space"
        deleteKeyCode={['Backspace', 'Delete']}
        zoomOnDoubleClick={false}
        onNodeDoubleClick={(_, node) => {
          if (!node.data.draft) openNodeTimeline(node.id);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={GRID_SIZE} size={1} color="#353535" />
        <ViewportPortal>
          <svg className="alignment-guides" aria-hidden="true">
            {guides.map((guide) => (
              <line
                key={guide.axis}
                x1={guide.axis === 'x' ? guide.value : guide.from}
                y1={guide.axis === 'y' ? guide.value : guide.from}
                x2={guide.axis === 'x' ? guide.value : guide.to}
                y2={guide.axis === 'y' ? guide.value : guide.to}
              />
            ))}
          </svg>
        </ViewportPortal>
        {map && (
          <MiniMap
            nodeColor={(n) =>
              (n.data as StoryFlowNode['data']).scene.kind === 'branch'
                ? '#858585'
                : (n.data as StoryFlowNode['data']).scene.kind === 'ending'
                  ? '#7f7f7f'
                  : '#464646'
            }
            maskColor="#141414bb"
            pannable
            zoomable
            position="bottom-right"
            style={{ width: 150, height: 100 }}
          />
        )}
      </ReactFlow>
      <div className="canvas-toolbar">
        <div className="tool-group">
          <IconButton
            label="选择工具"
            className={!pan ? 'active' : ''}
            onClick={() => setPan(false)}
          >
            <Cursor size={17} />
          </IconButton>
          <IconButton
            label="平移工具（空格）"
            className={pan ? 'active' : ''}
            onClick={() => setPan(true)}
          >
            <Hand size={17} />
          </IconButton>
        </div>
        <span className="toolbar-divider" />
        <IconButton label="缩小" onClick={() => flow.zoomOut({ duration: 180 })}>
          <Minus size={15} />
        </IconButton>
        <span className="zoom-value">{Math.round(zoom * 100)}%</span>
        <IconButton label="放大" onClick={() => flow.zoomIn({ duration: 180 })}>
          <Plus size={15} />
        </IconButton>
        <span className="toolbar-divider" />
        <IconButton label="适应画布" onClick={() => flow.fitView({ padding: 0.15, duration: 350 })}>
          <CornersOut size={17} />
        </IconButton>
        <IconButton label="自动整理蓝图" onClick={autoLayout}>
          <TreeStructure size={17} />
        </IconButton>
        <IconButton
          label="自动吸附"
          aria-pressed={snap}
          className={snap ? 'active' : ''}
          onClick={() => {
            setSnap(!snap);
            setGuides([]);
          }}
        >
          <Magnet size={17} />
        </IconButton>
        <IconButton label="切换缩略地图" onClick={() => setMap(!map)}>
          <MagnifyingGlass size={17} />
        </IconButton>
      </div>
      {menu && (
        <div className="context-menu dropdown-content" style={{ left: menu.x, top: menu.y }}>
          <button onClick={() => add('video')}>
            <FilmStrip size={16} />
            添加视频节点
          </button>
          <button onClick={() => add('branch')}>
            <GitBranch size={16} />
            添加条件分支
          </button>
          <button onClick={() => add('ending')}>
            <Trophy size={16} />
            添加故事结局
          </button>
        </div>
      )}
    </div>
  );
}
export function Blueprint() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
