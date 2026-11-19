import { z } from 'zod';
import { storyStartId, type Project, type Scene } from '../../domain/schema';
import {
  playerTextPlayback,
  dialogueEndMs,
  nodeDuration,
  stillClipsFor,
} from '../../domain/timeline';
import {
  advance,
  availableChoices,
  choose,
  finish,
  start,
  type RuntimeState,
} from '../../runtime/engine';
import type { ToolRegistry } from './registry';

const id = z.string().min(1).max(160);
const pageCharacters = 32_000;
const playbackQuery = z.strictObject({
  nodeIds: z
    .array(id)
    .min(1)
    .max(8)
    .optional()
    .describe('指定节点 ID。省略时使用选中节点或路线开头。'),
  fromNodeId: id.optional().describe('模拟播放的入口。省略时从指定章、当前章或全剧入口开始。'),
  chapterId: id.optional(),
  choiceIds: z
    .array(id)
    .max(25)
    .default([])
    .describe('按播放次序指定玩家选项 ID，自动分支按运行时状态判定。'),
  count: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(3)
    .describe('没有指定或选中节点时，读取开头几个播放节点。'),
  before: z.number().int().min(0).max(3).default(1).describe('每个目标之前的播放节点数。'),
  after: z.number().int().min(0).max(3).default(1).describe('每个目标之后的播放节点数。'),
  offset: z.number().int().nonnegative().default(0),
});
type PlaybackQuery = z.infer<typeof playbackQuery>;

function adjacentVisit(route: Scene[], anchor: number, distance: number, direction: -1 | 1) {
  let index = anchor;
  while (distance > 0 && route[index + direction]) {
    index += direction;
    if (route[index].kind !== 'branch') distance--;
  }
  return { index, complete: distance === 0 };
}

function playToDecision(project: Project, scene: Scene, state: RuntimeState) {
  const boundary = scene.choices.length ? scene.choicesAtMs : null;
  const end = Math.min(boundary ?? Infinity, nodeDuration(project, scene));
  const positions = [
    ...new Set(
      scene.events
        .filter(({ trigger, atMs }) => trigger === 'time' && atMs > 0 && atMs < end)
        .map(({ atMs }) => atMs),
    ),
  ].sort((a, b) => a - b);
  for (const position of positions) state = advance(project, state, position);
  return boundary === null ? finish(project, state) : advance(project, state, end);
}

function playbackWindow(
  project: Project,
  scenes: ReadonlyMap<string, Scene>,
  entry: string,
  targets: ReadonlySet<string>,
  { count, before, after, choiceIds }: PlaybackQuery,
) {
  const route: Scene[] = [];
  const anchors: number[] = [];
  const pending = new Set(targets);
  let state: RuntimeState | undefined;
  let usedChoices = 0;
  let stop: 'window' | 'choice' | 'ended' | 'limit' | 'route_error' = 'limit';
  let error: string | undefined;
  let choices: ReturnType<typeof availableChoices> | undefined;
  try {
    let next = start(project, entry);
    for (let transitions = 0; transitions <= 100; transitions++) {
      const sequence = state?.logSequence ?? 0;
      const entered = next.log.filter((event) => event.entered && (event.sequence ?? 0) > sequence);
      if (entered.length !== next.visitSerial - (state?.visitSerial ?? 0))
        throw new Error('一段自动跳转的入场记录超出运行时日志容量。');
      for (const { nodeId } of entered) {
        const node = scenes.get(nodeId)!;
        if (
          pending.delete(nodeId) ||
          (!targets.size && node.kind !== 'branch' && anchors.length < count)
        )
          anchors.push(route.length);
        route.push(node);
      }
      state = next;
      const reached = targets.size ? pending.size === 0 : anchors.length === count;
      if (reached && adjacentVisit(route, anchors.at(-1)!, after, 1).complete) {
        stop = 'window';
        break;
      }
      if (state.phase === 'ended') {
        stop = 'ended';
        break;
      }
      if (state.phase === 'choosing') {
        const choiceId = choiceIds[usedChoices];
        if (!choiceId) {
          stop = 'choice';
          choices = availableChoices(project, state);
          break;
        }
        next = choose(project, state, choiceId);
        usedChoices++;
      } else {
        next = playToDecision(project, scenes.get(state.nodeId)!, state);
      }
    }
  } catch (cause) {
    stop = 'route_error';
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const indices = new Set<number>();
  for (const anchor of anchors) {
    const first = adjacentVisit(route, anchor, before, -1).index;
    const last = adjacentVisit(route, anchor, after, 1).index;
    for (let index = first; index <= last; index++) indices.add(index);
  }
  return {
    visits: [...indices]
      .sort((a, b) => a - b)
      .map((index) => ({
        visit: index + 1,
        target: anchors.includes(index),
        node: route[index],
      })),
    unreachedNodeIds: [...pending],
    stop,
    stopNodeId: state?.nodeId,
    choices: choices?.slice(0, 8).map(({ choice, enabled }) => ({
      id: choice.id,
      label: choice.label,
      targetId: choice.targetId,
      enabled,
    })),
    moreChoices: choices && choices.length > 8 ? choices.length - 8 : undefined,
    error,
  };
}

function playbackDetails(
  project: Project,
  node: Scene,
  shots: NonNullable<Project['productionShots']>,
  assets: ReadonlyMap<string, Project['assets'][number]>,
) {
  const assetName = (assetId: string) => assets.get(assetId)?.name;
  const durationMs = nodeDuration(project, node);
  let videoStartMs = 0;
  const video = (node.timeline?.videoClips ?? []).map((clip) => {
    const startMs = videoStartMs;
    videoStartMs += clip.trimEndMs - clip.trimStartMs;
    return { ...clip, assetName: assetName(clip.assetId), startMs, endMs: videoStartMs };
  });
  const legacy = node.assetId && !node.timeline ? assets.get(node.assetId) : undefined;
  if (legacy?.type === 'video')
    video.push({
      id: 'video:legacy',
      assetId: legacy.id,
      assetName: legacy.name,
      trimStartMs: node.trimStartMs,
      trimEndMs: node.trimEndMs ?? (legacy.durationMs || node.durationMs),
      volume: 1,
      startMs: 0,
      endMs: durationMs,
    });
  let stillStartMs = 0;
  const still = stillClipsFor(project, node).map((clip) => {
    const startMs = stillStartMs;
    stillStartMs += clip.durationMs;
    return { ...clip, assetName: assetName(clip.assetId), startMs, endMs: stillStartMs };
  });
  const audio = [...(node.timeline?.audioClips ?? [])]
    .sort((a, b) => a.startMs - b.startMs)
    .map((clip) => ({
      ...clip,
      assetName: assetName(clip.assetId),
      endMs: clip.startMs + clip.durationMs,
    }));
  const playerText = playerTextPlayback(project, node);
  return {
    storyboardPages: node.storyboardPages ?? [],
    storyboardPlays: playerText.mode === 'paged' || playerText.mode === 'overlay',
    ...(playerText.mode === 'overlay' && { storyboardOverlay: true }),
    ...(node.kind === 'video' && { playerTextPlayback: playerText }),
    endingText: node.kind === 'ending' ? node.endingText : undefined,
    notes: node.notes || undefined,
    storyMessages: node.events.flatMap(({ trigger, atMs, effects }) =>
      effects.flatMap((effect) =>
        effect.kind === 'showMessage'
          ? [{ trigger, atMs, title: effect.title, text: effect.text }]
          : [],
      ),
    ),
    // The cards describe planned footage and dialogue. The timeline describes the bound media.
    shots: shots.map(
      ({ firstFramePrompt, lastFramePrompt, videoPrompt, videoModel, nodeId, ...shot }) => shot,
    ),
    timeline:
      node.kind === 'video'
        ? { durationMs, dialogueEndMs: dialogueEndMs(node), video, still, audio }
        : undefined,
  };
}

export function registerPlaybackTool(registry: ToolRegistry) {
  registry.register({
    name: 'read_playback',
    label: '读取播放顺序与分镜对白',
    group: 'story',
    category: 'analysis',
    mode: 'read',
    maxResultCharacters: pageCharacters,
    description:
      '检查几个小节的顺序、剧情与声画衔接时优先单独调用。按播放器实际跳转一次返回目标及前后节点的剧情文字、实际显示状态与有效时长、镜头卡对白和动作、视频/静态/音频轨。传 nodeIds 指定节点，无 ID 时使用选中节点，或用 count 读取开头几个节点。按 choiceIds 走指定玩家路线，未指定选项时停在选择处。按 nextOffset 续页；仅针对具体疑点补查。音视频内容未被转录或识别。',
    schema: playbackQuery,
    execute({ project, activeChapterId, selectedIds, readPageCharacters }, query) {
      const scenes = new Map(project.scenes.map((node) => [node.id, node]));
      const chapter = project.chapters.find(
        ({ id }) => id === (query.chapterId ?? activeChapterId),
      );
      if (query.chapterId && !chapter) throw new Error('指定章节不存在。');
      if (!query.fromNodeId && chapter && !chapter.startNodeId)
        throw new Error('该章没有可播放的入口节点。');
      const entry = query.fromNodeId ?? chapter?.startNodeId ?? storyStartId(project);
      const targets = new Set(
        query.nodeIds ??
          (query.chapterId || query.fromNodeId
            ? []
            : selectedIds.filter((id) => scenes.has(id)).slice(0, 8)),
      );
      for (const nodeId of [entry, ...targets])
        if (!scenes.has(nodeId))
          throw new Error(`找不到节点 ${nodeId}，请使用工程中的实际节点 ID。`);

      const { visits, ...route } = playbackWindow(project, scenes, entry, targets, query);
      const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
      const shotsByNode = new Map<string, NonNullable<Project['productionShots']>>();
      const visibleIds = new Set(visits.map(({ node }) => node.id));
      for (const shot of project.productionShots ?? []) {
        if (!visibleIds.has(shot.nodeId)) continue;
        const shots = shotsByNode.get(shot.nodeId) ?? [];
        shots.push(shot);
        shotsByNode.set(shot.nodeId, shots);
      }

      const rows: object[] = [];
      const data = {
        entryNodeId: entry,
        ...route,
        offset: query.offset,
        total: visits.length,
        nextOffset: null as number | null,
        truncated: false,
        omittedDetails: false,
        nodes: rows,
      };
      const budget = Math.min(pageCharacters, readPageCharacters ?? pageCharacters);
      for (const { node, visit, target } of visits.slice(query.offset)) {
        const summary = {
          id: node.id,
          chapterId: node.chapterId,
          title: node.title,
          kind: node.kind,
          visit,
          target,
        };
        const shots = shotsByNode.get(node.id) ?? [];
        const details = playbackDetails(project, node, shots, assets);
        rows.push({
          ...summary,
          choiceQuestion: node.choiceQuestion,
          choicesAtMs: node.choices.length ? node.choicesAtMs : undefined,
          choiceMode: node.choices.length ? node.choiceMode : undefined,
          ...details,
        });
        if (JSON.stringify(data).length + 32 <= budget) continue;
        rows.pop();
        if (rows.length) break;
        data.omittedDetails = true;
        rows.push({
          ...summary,
          detailsOmitted: true,
          detailHint:
            '单节点超出预算，用此 ID 按具体疑点查询 read_story 的 read、timeline 或 shots。',
        });
      }
      const end = query.offset + rows.length;
      data.nextOffset = end < visits.length ? end : null;
      data.truncated = data.nextOffset !== null || data.omittedDetails;
      return { ok: true, summary: `按播放顺序读取 ${rows.length} 个节点`, data };
    },
  });
}
