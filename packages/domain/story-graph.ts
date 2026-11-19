import type { Scene } from './schema';

export const automaticBranchLimit = 100;

export function storyTargets(scene: Scene): string[] {
  if (scene.kind === 'ending') return [];
  if (!scene.choices.length) return scene.kind === 'video' && scene.nextId ? [scene.nextId] : [];
  if (scene.kind === 'video') return scene.choices.map(({ targetId }) => targetId);
  const fallback = scene.choices.findIndex(
    ({ condition }) => condition.kind === 'all' && !condition.children.length,
  );
  return (fallback < 0 ? scene.choices : scene.choices.slice(0, fallback + 1)).map(
    ({ targetId }) => targetId,
  );
}

export function reachableStoryNodes(scenes: ReadonlyMap<string, Scene>, starts: readonly string[]) {
  const pending = [...starts];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    const scene = scenes.get(id);
    if (!scene || visited.has(id)) continue;
    visited.add(id);
    for (const target of storyTargets(scene)) pending.push(target);
  }
  return visited;
}

export function inspectAutomaticBranches(scenes: ReadonlyMap<string, Scene>) {
  const incoming = new Map<string, number>();
  const depths = new Map<string, number>();
  for (const [id, scene] of scenes) if (scene.kind === 'branch') incoming.set(id, 0);
  for (const id of incoming.keys())
    for (const target of storyTargets(scenes.get(id)!))
      if (incoming.has(target)) incoming.set(target, incoming.get(target)! + 1);
  const pending = [...incoming.keys()].filter((id) => incoming.get(id) === 0);
  let visited = 0;
  let tooLong: string | undefined;
  while (pending.length) {
    const id = pending.pop()!;
    visited++;
    const depth = depths.get(id) ?? 1;
    if (depth > automaticBranchLimit) tooLong ??= id;
    for (const target of storyTargets(scenes.get(id)!)) {
      if (!incoming.has(target)) continue;
      const left = incoming.get(target)! - 1;
      incoming.set(target, left);
      depths.set(target, Math.max(depths.get(target) ?? 1, depth + 1));
      if (!left) pending.push(target);
    }
  }
  return { cyclic: visited !== incoming.size, tooLong };
}
