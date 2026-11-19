import type { Project } from '../../../packages/domain/schema';
import type { RuntimeState } from '../../../packages/runtime/engine';
import type { SaveStorage } from './saves';

export interface RouteProgress {
  nodes: string[];
  choices: string[];
}
export function mergeProgress(
  p: Project,
  previous: RouteProgress,
  state: RuntimeState,
): RouteProgress {
  const nodeIds = new Set(p.scenes.map((s) => s.id));
  const choiceIds = new Set(p.scenes.flatMap((s) => s.choices.map((c) => c.id)));
  return {
    nodes: [...new Set([...previous.nodes, ...state.visited])].filter((id) => nodeIds.has(id)),
    choices: [...new Set([...previous.choices, ...state.takenChoices])].filter((id) =>
      choiceIds.has(id),
    ),
  };
}
export function readProgress(storage: SaveStorage, key: string): RouteProgress {
  try {
    const raw = JSON.parse(storage.getItem(key) ?? 'null') as RouteProgress;
    return {
      nodes: Array.isArray(raw?.nodes) ? raw.nodes.filter((id) => typeof id === 'string') : [],
      choices: Array.isArray(raw?.choices)
        ? raw.choices.filter((id) => typeof id === 'string')
        : [],
    };
  } catch {
    return { nodes: [], choices: [] };
  }
}
export function routeStatus(
  p: Project,
  state: RuntimeState,
  progress: RouteProgress,
  sceneId: string,
  choiceId: string,
) {
  if (
    !p.scenes
      .find((scene) => scene.id === sceneId)
      ?.choices.some((choice) => choice.id === choiceId)
  )
    return '待探索';
  if (state.takenChoices.includes(choiceId)) return '本局已选';
  if (progress.choices.includes(choiceId)) return '曾经走过';
  return '待探索';
}
