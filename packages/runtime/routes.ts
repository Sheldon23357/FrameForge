import type { Project } from '../domain/schema';
import {
  advance,
  availableChoices,
  choose,
  finish,
  getScene,
  sceneDuration,
  start,
  type RuntimeState,
} from './engine';

const stateLimit = 2000;

/** Explore clickable routes using the same conditions, events and choices as playback. */
export function exploreStoryRoutes(
  project: Project,
  startNodeId?: string,
  chapterExit?: { chapterId: string; handoffId?: string },
) {
  const pending: { state: RuntimeState; choiceIds: string[] }[] = [];
  const seen = new Map<string, number>();
  const parents: Set<number>[] = [];
  const terminalStates: number[] = [];
  const destinations = new Set<string>();
  const endings = new Map<
    string,
    { nodeId: string; title: string; choiceIds: string[]; choiceCount: number }
  >();
  const failures = new Set<string>();
  let distinctChoices = false;
  let truncated = false;
  const enqueue = (state: RuntimeState, choiceIds: string[], from?: number) => {
    // Once-only events persist across visits. Other events only affect the current visit.
    const visit = `${state.visitSerial}:`;
    const fired = state.fired.flatMap((id) => {
      if (id.startsWith(visit)) return [id.slice(visit.length) + ':current'];
      return /^\d+:/.test(id) ? [] : [id];
    });
    const key = JSON.stringify([
      state.nodeId,
      state.phase,
      state.positionMs,
      state.variables,
      state.inventory,
      [...state.visited].sort(),
      fired.sort(),
    ]);
    const prior = seen.get(key);
    if (prior !== undefined) {
      if (from !== undefined) parents[prior].add(from);
      return;
    }
    if (seen.size >= stateLimit) {
      truncated = true;
      return;
    }
    seen.set(key, pending.length);
    parents.push(new Set(from === undefined ? [] : [from]));
    pending.push({ state, choiceIds });
  };
  enqueue(start(project, startNodeId), []);
  for (let index = 0; index < pending.length; index++) {
    const { state, choiceIds } = pending[index];
    const scene = getScene(project, state);
    try {
      if (
        chapterExit &&
        (scene.chapterId !== chapterExit.chapterId ||
          (scene.id === chapterExit.handoffId && state.phase === 'ended'))
      ) {
        terminalStates.push(index);
      } else if (state.phase === 'ended') {
        if (scene.kind !== 'ending') failures.add(`「${scene.title}」播完后没有出口`);
        else {
          terminalStates.push(index);
          if (!endings.has(scene.id))
            endings.set(scene.id, {
              nodeId: scene.id,
              title: scene.title,
              choiceIds: choiceIds.slice(0, 50),
              choiceCount: choiceIds.length,
            });
        }
      } else if (state.phase === 'playing') {
        const next =
          scene.choices.length && scene.choicesAtMs !== null
            ? advance(project, state, scene.choicesAtMs)
            : finish(project, state);
        enqueue(next, choiceIds, index);
      } else {
        const choices = availableChoices(project, state).filter(({ enabled }) => enabled);
        const duration = sceneDuration(project, scene);
        if (scene.choiceMode === 'continue' && state.positionMs < duration) {
          const nextEvent = scene.events.reduce(
            (next, event) =>
              event.trigger === 'time' && event.atMs > state.positionMs
                ? Math.min(next, event.atMs)
                : next,
            duration,
          );
          enqueue(advance(project, state, nextEvent), choiceIds, index);
        } else if (!choices.length) {
          failures.add(`「${scene.title}」没有可点击的选项`);
        }
        const targets = new Set<string>();
        for (const { choice } of choices) {
          try {
            const next = choose(project, state, choice.id);
            enqueue(next, [...choiceIds, choice.id], index);
            targets.add(next.nodeId);
            destinations.add(next.nodeId);
          } catch (error) {
            failures.add(`${choice.label} · ${String(error)}`);
          }
        }
        distinctChoices ||= targets.size >= 2;
      }
    } catch (error) {
      failures.add(String(error));
    }
  }
  if (!truncated) {
    const canEnd = new Set(terminalStates);
    for (const node of terminalStates) {
      for (const parent of parents[node]) {
        if (canEnd.has(parent)) continue;
        canEnd.add(parent);
        terminalStates.push(parent);
      }
    }
    pending.forEach(({ state }, index) => {
      if (!canEnd.has(index))
        failures.add(`「${getScene(project, state).title}」在某条可达路线中无法到达结局`);
    });
  }
  return {
    distinctChoices,
    destinations: destinations.size,
    endings: endings.size,
    routes: [...endings.values()],
    states: seen.size,
    truncated,
    failures: [...failures],
  };
}
