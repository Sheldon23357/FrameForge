import { z } from 'zod';
import type { Project, Value } from '../../domain/schema';
import { playerTextPlayback } from '../../domain/timeline';
import {
  advance,
  availableChoices,
  choose,
  finish,
  getScene,
  sceneDuration,
  start,
  type RuntimeState,
} from '../../runtime/engine';

const value = z.union([z.string(), z.number().finite(), z.boolean()]);
const step = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('choose'), choiceId: z.string().min(1) }),
  z.strictObject({ action: z.literal('wait'), durationMs: z.number().int().min(1).max(3_600_000) }),
]);
export type StoryRouteStep = z.infer<typeof step>;
export const routeSimulationFields = {
  nodeId: z.string().optional(),
  choiceIds: z.array(z.string()).max(50).default([]),
  steps: z.array(step).max(50).optional(),
  initialVariables: z.record(z.string(), value).optional(),
  initialInventory: z.record(z.string(), z.number().int().nonnegative()).optional(),
  detail: z.enum(['summary', 'trace', 'pacing']).default('trace'),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(25).default(15),
};
type RouteInput = z.infer<z.ZodObject<typeof routeSimulationFields>>;

function changedValues<T extends Value>(before: Record<string, T>, after: Record<string, T>) {
  return Object.entries(after)
    .filter(([id, value]) => value !== before[id])
    .map(([id, value]) => ({ id, before: before[id], after: value }));
}

function routePacing(project: Project) {
  const plannedMs = new Map<string, number>();
  for (const { nodeId, durationMs } of project.productionShots ?? [])
    plannedMs.set(nodeId, (plannedMs.get(nodeId) ?? 0) + durationMs);
  const rows = new Map<number, ReturnType<typeof describe>>();
  let choices = 0;

  function describe(state: RuntimeState) {
    const node = getScene(project, state);
    return {
      nodeId: node.id,
      title: node.title,
      chapterId: node.chapterId,
      playedMs: 0,
      durationMs: sceneDuration(project, node),
      plannedShotMs: plannedMs.get(node.id) ?? null,
      playerText: playerTextPlayback(project, node),
    };
  }
  function enter(state: RuntimeState) {
    if (!rows.has(state.visitSerial) && getScene(project, state).kind === 'video')
      rows.set(state.visitSerial, describe(state));
  }
  return {
    enter,
    record(action: string, before: RuntimeState, after: RuntimeState, chapterExited: boolean) {
      if (action === 'choose') choices++;
      else {
        const row = rows.get(before.visitSerial);
        if (row) {
          const end = before.visitSerial === after.visitSerial ? after.positionMs : row.durationMs;
          row.playedMs += Math.max(0, end - before.positionMs);
        }
      }
      if (!chapterExited) enter(after);
    },
    page(offset: number, limit: number) {
      const completeRoute = [...rows.values()];
      const chapters = new Map<
        string,
        { chapterId: string; playedMs: number; videoVisits: number }
      >();
      let playedMs = 0;
      for (const row of completeRoute) {
        const chapter = chapters.get(row.chapterId) ?? {
          chapterId: row.chapterId,
          playedMs: 0,
          videoVisits: 0,
        };
        playedMs += row.playedMs;
        chapter.playedMs += row.playedMs;
        chapter.videoVisits++;
        chapters.set(row.chapterId, chapter);
      }
      const end = offset + limit;
      const page = completeRoute.slice(offset, end);
      const pageChapters = [...new Set(page.map(({ chapterId }) => chapterId))];
      return {
        playedMs,
        choices,
        total: completeRoute.length,
        chapters: pageChapters.map((id) => chapters.get(id)!),
        rows: page,
        offset,
        nextOffset: end < completeRoute.length ? end : null,
        truncated: end < completeRoute.length,
      };
    },
  };
}

export function simulateStoryRoute(project: Project, input: RouteInput, chapterId?: string) {
  if (input.steps && input.choiceIds.length)
    throw new Error('请使用 steps 或 choiceIds 其中一种。');
  const steps =
    input.steps ?? input.choiceIds.map((choiceId) => ({ action: 'choose' as const, choiceId }));
  const selectedChoices = new Set(
    steps.flatMap((step) => (step.action === 'choose' ? [step.choiceId] : [])),
  );
  const automatic = project.scenes.find(
    (scene) => scene.kind === 'branch' && scene.choices.some(({ id }) => selectedChoices.has(id)),
  );
  if (automatic)
    throw new Error(
      `「${automatic.title}」(${automatic.id}) 是自动条件分支，它的出口不能作为 simulate 的玩家选择。若需要玩家点击，请把选项放到视频节点，再用 check_story 的 explore 验收。`,
    );
  let traceComplete = true;
  let chapterEntered = false;
  let chapterExited = false;
  const chapterMembers = chapterId
    ? new Set(project.scenes.filter((node) => node.chapterId === chapterId).map(({ id }) => id))
    : undefined;
  const traceEntry = (action: string, next: RuntimeState, before?: RuntimeState) => {
    const sequence = before?.logSequence ?? 0;
    const events = next.log.filter((event) => (event.sequence ?? 0) > sequence);
    const entered = events.filter((event) => event.entered).map((event) => event.nodeId);
    if (chapterMembers)
      for (const id of entered) {
        if (!chapterMembers.has(id)) chapterExited ||= chapterEntered;
        else chapterEntered = true;
      }
    if ((next.logSequence ?? 0) - sequence > events.length) traceComplete = false;
    return {
      action,
      fromNodeId: before?.nodeId,
      nodeId: next.nodeId,
      phase: next.phase,
      positionMs: next.positionMs,
      enteredNodeIds: entered,
      variables: before ? changedValues(before.variables, next.variables) : [],
      inventory: before ? changedValues(before.inventory, next.inventory) : [],
    };
  };
  const trace: ReturnType<typeof traceEntry>[] = [];
  const initial = start(project, input.nodeId, {
    variables: input.initialVariables,
    inventory: input.initialInventory,
  });
  const pacing = input.detail === 'pacing' ? routePacing(project) : undefined;
  pacing?.enter(initial);
  let state = initial;
  trace.push(traceEntry('start', state));
  const record = (action: string, next: RuntimeState) => {
    trace.push(traceEntry(action, next, state));
    pacing?.record(action, state, next, chapterExited);
    state = next;
  };
  const playToDecision = () => {
    let transitions = 0;
    while (state.phase === 'playing' && !chapterExited) {
      if (++transitions > 100) throw new Error('连续自动播放超过 100 个节点，可能存在循环。');
      const scene = getScene(project, state);
      const next =
        scene.choices.length && scene.choicesAtMs !== null
          ? advance(project, state, scene.choicesAtMs)
          : finish(project, state);
      record('play', next);
    }
  };
  for (const step of steps) {
    playToDecision();
    if (chapterExited) break;
    if (step.action === 'choose') {
      record('choose', choose(project, state, step.choiceId));
      continue;
    }
    if (state.phase !== 'choosing') throw new Error('等待操作需要停在玩家选择阶段。');
    const scene = getScene(project, state);
    if (scene.choiceMode === 'pause') {
      record('wait', state);
      continue;
    }
    const duration = sceneDuration(project, scene);
    const target = Math.min(duration, state.positionMs + step.durationMs);
    const ends = [
      ...new Set(
        scene.events
          .filter(
            (event) =>
              event.trigger === 'time' && event.atMs > state.positionMs && event.atMs < target,
          )
          .map((event) => event.atMs),
      ),
    ].sort((a, b) => a - b);
    for (const position of [...ends, target]) record('wait', advance(project, state, position));
  }
  if (pacing || steps.length || input.steps || input.initialVariables || input.initialInventory)
    playToDecision();
  const end = input.offset + input.limit;
  if (pacing) {
    const destination = getScene(project, state);
    return {
      nodeId: destination.id,
      phase: state.phase,
      ending: state.phase === 'ended' && destination.kind === 'ending',
      availableChoiceIds: availableChoices(project, state)
        .filter(({ enabled }) => enabled)
        .slice(0, 12)
        .map(({ choice }) => choice.id),
      ...pacing.page(input.offset, input.limit),
    };
  }
  if (input.detail === 'summary') {
    return {
      nodeId: state.nodeId,
      phase: state.phase,
      ending: state.phase === 'ended' && getScene(project, state).kind === 'ending',
      availableChoiceIds: availableChoices(project, state)
        .filter(({ enabled }) => enabled)
        .slice(0, 12)
        .map(({ choice }) => choice.id),
      traceComplete,
      total: trace.length,
      detailHint: '使用相同路线参数，传 detail=trace、offset=0 和较小的 limit 读取轨迹。',
    };
  }
  return {
    nodeId: state.nodeId,
    phase: state.phase,
    positionMs: state.positionMs,
    ...(chapterId && { chapterExited }),
    variables: state.variables,
    inventory: state.inventory,
    choices: availableChoices(project, state),
    log: state.log.slice(-20),
    takenChoiceIds: state.takenChoices,
    trace: trace.slice(input.offset, end),
    visitedNodeIds: state.visited,
    traceComplete,
    total: trace.length,
    offset: input.offset,
    nextOffset: end < trace.length ? end : null,
    truncated: end < trace.length,
  };
}
