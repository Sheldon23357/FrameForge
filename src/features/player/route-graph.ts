import { type Project, type Scene, storyStartId } from '../../../packages/domain/schema';
import { evaluate, type RuntimeState } from '../../../packages/runtime/engine';

export const ROUTE_NODE_WIDTH = 220;
export const ROUTE_NODE_HEIGHT = 88;
export interface RouteGraphNode {
  scene: Pick<Scene, 'id' | 'title' | 'chapterId' | 'kind'>;
  x: number;
  y: number;
  external: boolean;
  preview: boolean;
}
export interface RouteGraphEdge {
  id: string;
  source: string;
  target: string;
  path: string;
  preview: boolean;
}
export function buildRouteGraph(p: Project, state: RuntimeState, chapterId = '') {
  const known = new Set([...state.visited, state.nodeId]);
  const taken = new Set(state.takenChoices);
  const all = new Map(p.scenes.map((scene) => [scene.id, scene]));
  const exploredScenes = p.scenes.filter((scene) => known.has(scene.id));
  const routes = new Map<string, { id: string; targetId: string; preview: boolean }[]>();
  const previews = new Set<string>();
  for (const scene of exploredScenes) {
    if (scene.kind === 'ending') continue;
    const currentChoice = scene.id === state.nodeId && state.phase === 'choosing';
    const offered = currentChoice || scene.choices.some((choice) => taken.has(choice.id));
    // Only the current choice screen can confirm whether an unchosen hidden option was visible.
    const exits = scene.choices.flatMap((choice) => {
      if (taken.has(choice.id) && known.has(choice.targetId) && all.has(choice.targetId))
        return [{ id: choice.id, targetId: choice.targetId, preview: false }];
      if (
        scene.kind !== 'video' ||
        !offered ||
        taken.has(choice.id) ||
        known.has(choice.targetId) ||
        !all.has(choice.targetId) ||
        (choice.hiddenWhenLocked && (!currentChoice || !evaluate(choice.condition, state)))
      )
        return [];
      previews.add(choice.targetId);
      return [{ id: choice.id, targetId: choice.targetId, preview: true }];
    });
    if (!scene.choices.length && known.has(scene.nextId) && all.has(scene.nextId))
      exits.push({ id: `next:${scene.id}`, targetId: scene.nextId, preview: false });
    routes.set(scene.id, exits);
  }
  const exits = (scene: Scene) => routes.get(scene.id) ?? [];
  const visibleScenes = p.scenes.filter((scene) => known.has(scene.id) || previews.has(scene.id));
  const included = new Set(
    visibleScenes.filter((s) => !chapterId || s.chapterId === chapterId).map((s) => s.id),
  );
  if (chapterId)
    for (const scene of exploredScenes)
      for (const exit of exits(scene)) {
        if (scene.chapterId === chapterId) included.add(exit.targetId);
        if (all.get(exit.targetId)?.chapterId === chapterId) included.add(scene.id);
      }
  const scenes = visibleScenes.filter((s) => included.has(s.id));
  const ranks = new Map<string, number>();
  const seed = chapterId
    ? p.chapters.find((c) => c.id === chapterId)?.startNodeId
    : storyStartId(p);
  // Put incoming chapter context before this chapter's start. Seeding the
  // current chapter first made an ordinary incoming link look like a loop.
  const visibleExits = (scene: Scene) =>
    exits(scene).filter(
      ({ targetId }) =>
        included.has(targetId) &&
        (!chapterId || scene.chapterId === chapterId || all.get(targetId)?.chapterId === chapterId),
    );
  const incoming = new Set(
    scenes.flatMap((scene) => visibleExits(scene).map((exit) => exit.targetId)),
  );
  const roots = [
    ...scenes.filter((scene) => !incoming.has(scene.id)).map((scene) => scene.id),
    seed,
    ...scenes.map((s) => s.id),
  ].filter((id): id is string => !!id && included.has(id));
  let maximumRank = -1;
  for (const root of roots) {
    if (ranks.has(root)) continue;
    ranks.set(root, maximumRank + 1);
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      const scene = all.get(queue[i])!;
      const rank = ranks.get(scene.id)!;
      maximumRank = Math.max(maximumRank, rank);
      for (const exit of visibleExits(scene))
        if (!ranks.has(exit.targetId)) {
          ranks.set(exit.targetId, rank + 1);
          queue.push(exit.targetId);
        }
    }
  }
  const rows = new Map<number, number>();
  const nodes = scenes.map((scene) => {
    const rank = ranks.get(scene.id) ?? 0;
    const row = rows.get(rank) ?? 0;
    rows.set(rank, row + 1);
    return {
      scene,
      x: 110 + rank * 360,
      y: 55 + row * 185,
      external: !!chapterId && scene.chapterId !== chapterId,
      preview: previews.has(scene.id),
    };
  });
  const byId = new Map(nodes.map((node) => [node.scene.id, node]));
  const edges: RouteGraphEdge[] = [];
  let width = Math.max(500, ...nodes.map((n) => n.x + ROUTE_NODE_WIDTH + 110));
  let height = Math.max(260, ...nodes.map((n) => n.y + ROUTE_NODE_HEIGHT + 55));
  let returnLane = 0;
  for (const source of nodes) {
    const outgoing = visibleExits(source.scene);
    outgoing.forEach((exit, index) => {
      const target = byId.get(exit.targetId)!;
      const x1 = source.x + ROUTE_NODE_WIDTH;
      const y1 = source.y + ROUTE_NODE_HEIGHT / 2;
      const x2 = target.x;
      const y2 = target.y + ROUTE_NODE_HEIGHT / 2;
      let path: string;
      if (x2 > x1) {
        const distance = Math.max(50, (x2 - x1) / 2);
        const parallel = outgoing.filter((other) => other.targetId === exit.targetId);
        const parallelIndex = outgoing
          .slice(0, index)
          .filter((other) => other.targetId === exit.targetId).length;
        const offset = (parallelIndex - (parallel.length - 1) / 2) * 58;
        path = `M ${x1} ${y1} C ${x1 + distance} ${y1 + offset}, ${x2 - distance} ${y2 + offset}, ${x2} ${y2}`;
      } else {
        const lane = Math.max(source.y, target.y) + ROUTE_NODE_HEIGHT + 56 + returnLane++ * 34;
        path = `M ${x1} ${y1} C ${x1 + 65} ${y1}, ${x1 + 65} ${lane}, ${x1} ${lane} L ${x2 - 65} ${lane} C ${x2 - 100} ${lane}, ${x2 - 100} ${y2}, ${x2} ${y2}`;
        height = Math.max(height, lane + 60);
        width = Math.max(width, x1 + 100);
      }
      edges.push({
        id: exit.id,
        source: source.scene.id,
        target: exit.targetId,
        path,
        preview: exit.preview,
      });
    });
  }
  const publicNodes: RouteGraphNode[] = nodes.map(({ scene, ...geometry }) => {
    return {
      ...geometry,
      scene: {
        id: scene.id,
        chapterId: scene.chapterId,
        title: geometry.preview ? '未知节点' : scene.kind === 'branch' ? '剧情分支' : scene.title,
        kind: geometry.preview ? 'video' : scene.kind,
      },
    };
  });
  return { nodes: publicNodes, edges, width, height };
}
