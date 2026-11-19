import { storyStartId, type Project, type Scene } from './schema';

export function blueprintTargets(scene: Scene) {
  if (scene.kind === 'ending') return [];
  if (scene.choices.length) return scene.choices.map(({ targetId }) => targetId).filter(Boolean);
  return scene.kind === 'video' && scene.nextId ? [scene.nextId] : [];
}

export function arrangeBlueprint(project: Project, chapterId: string | null) {
  const scenes = new Map(
    project.scenes.filter((s) => !chapterId || s.chapterId === chapterId).map((s) => [s.id, s]),
  );
  const outgoing = new Map<string, string[]>();
  const incoming = new Map([...scenes.keys()].map((id) => [id, [] as string[]]));
  for (const [id, scene] of scenes) {
    const targets = [...new Set(blueprintTargets(scene))].filter((target) => scenes.has(target));
    outgoing.set(id, targets);
    for (const target of targets) incoming.get(target)!.push(id);
  }
  const start = chapterId
    ? project.chapters.find((chapter) => chapter.id === chapterId)?.startNodeId
    : storyStartId(project);
  const roots = [
    ...(start ? [start] : []),
    ...[...incoming].filter(([, sources]) => !sources.length).map(([id]) => id),
    ...project.chapters.map(({ startNodeId }) => startNodeId),
    ...scenes.keys(),
  ];
  const seen = new Set<string>();
  const layout: Project['layout'] = {};
  let top = 60;
  for (const root of roots) {
    if (!scenes.has(root) || seen.has(root)) continue;
    const component = new Set([root]);
    const pending = [root];
    for (const id of pending) {
      for (const neighbor of [...outgoing.get(id)!, ...incoming.get(id)!]) {
        if (component.has(neighbor)) continue;
        component.add(neighbor);
        pending.push(neighbor);
      }
    }

    // Ignore DFS back edges for placement only. They remain visible on the canvas.
    const active = new Set<string>();
    const forward = new Map<string, string[]>();
    const postorder: string[] = [];
    const order = new Map<string, number>();
    const visit = (id: string) => {
      seen.add(id);
      active.add(id);
      forward.set(id, []);
      order.set(id, order.size);
      return { id, index: 0 };
    };
    const entries = [root, ...pending.filter((id) => !incoming.get(id)!.length), ...pending];
    for (const entry of entries) {
      if (seen.has(entry)) continue;
      const stack = [visit(entry)];
      while (stack.length) {
        const frame = stack[stack.length - 1];
        const target = outgoing.get(frame.id)![frame.index++];
        if (target === undefined) {
          active.delete(frame.id);
          postorder.push(frame.id);
          stack.pop();
        } else if (!active.has(target)) {
          forward.get(frame.id)!.push(target);
          if (!seen.has(target)) stack.push(visit(target));
        }
      }
    }

    const ranks = new Map<string, number>();
    const columns: string[][] = [];
    const parents = new Map(pending.map((id) => [id, [] as string[]]));
    for (const id of postorder.reverse()) {
      const rank = ranks.get(id) ?? 0;
      (columns[rank] ??= []).push(id);
      for (const target of forward.get(id)!) {
        ranks.set(target, Math.max(ranks.get(target) ?? 0, rank + 1));
        parents.get(target)!.push(id);
      }
    }

    const centers = new Map<string, number>();
    const heights = new Map(pending.map((id) => [id, 300 + 36 * scenes.get(id)!.choices.length]));
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [column, ids] of columns.entries()) {
      const rows = ids.map((id) => {
        const sources = parents.get(id)!;
        const center = sources.length
          ? sources.reduce((sum, source) => sum + centers.get(source)!, 0) / sources.length
          : 0;
        return { id, center, height: heights.get(id)! };
      });
      rows.sort((a, b) => a.center - b.center || order.get(a.id)! - order.get(b.id)!);
      let end = -Infinity;
      const placed = rows.map(({ center, height }) => {
        const y = Math.max(center - height / 2, end + 56);
        end = y + height;
        return y;
      });
      const shift =
        rows.reduce((sum, row, i) => sum + placed[i] + row.height / 2 - row.center, 0) /
        rows.length;
      rows.forEach(({ id, height }, i) => {
        const y = placed[i] - shift;
        centers.set(id, y + height / 2);
        layout[id] = { x: column * 370 + 40, y };
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y + height);
      });
    }
    for (const id of pending) layout[id].y = Math.round(layout[id].y - minY + top);
    top += maxY - minY + 120;
  }
  return layout;
}
