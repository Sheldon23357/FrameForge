import { z } from 'zod';
import type { Project } from '../../domain/schema';
import { screenplayBlocks, screenplayNeedsReview, updateScreenplay } from '../../domain/screenplay';
import { routeSimulationFields, simulateStoryRoute, type StoryRouteStep } from './route-simulation';
import { sceneDuration } from '../../runtime/engine';
import type { ToolRegistry } from './registry';

const id = z.string().min(1).max(160);
const page = {
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(25).default(12),
};

export function readScreenplayRoute(
  project: Project,
  chapterId: string,
  steps: StoryRouteStep[],
  fromChapter = false,
) {
  const chapter = project.chapters.find(({ id }) => id === chapterId);
  if (!chapter) throw new Error('找不到指定章节。');
  if (fromChapter && !chapter.startNodeId) throw new Error('该章还没有可读的蓝图入口。');
  const nodes = new Map(project.scenes.map((node) => [node.id, node]));
  const entries = new Map(project.screenplays?.map((entry) => [entry.id, entry]));
  const rows = [];
  let entered = false;
  let ended = false;
  const route = simulateStoryRoute(
    project,
    {
      nodeId: fromChapter ? chapter.startNodeId : undefined,
      choiceIds: [],
      steps,
      detail: 'trace',
      offset: 0,
      limit: Number.MAX_SAFE_INTEGER,
    },
    chapterId,
  );
  if (!('trace' in route) || !route.traceComplete)
    throw new Error('路线轨迹不完整，请从更近的章入口阅读。');
  for (const nodeId of route.trace.flatMap(({ enteredNodeIds }) => enteredNodeIds)) {
    const node = nodes.get(nodeId);
    if (node?.chapterId !== chapterId) {
      if (entered) {
        if (!ended && rows.at(-1)?.kind === 'branch') rows[rows.length - 1].target = node?.title;
        ended = true;
      }
      continue;
    }
    if (ended) continue;
    entered = true;
    if (rows.at(-1)?.kind === 'branch') rows[rows.length - 1].target = node.title;
    rows.push({
      id: nodeId,
      title: node.title,
      kind: node.kind,
      target: undefined as string | undefined,
      endingText: node.endingText,
      entry: entries.get(nodeId),
    });
  }
  const current = nodes.get(route.nodeId);
  return {
    rows,
    chapterExited: ended || route.chapterExited,
    decision:
      !ended && !route.chapterExited && route.phase === 'choosing' && current && route.choices
        ? {
            nodeId: current.id,
            title: current.title,
            chapterId: current.chapterId,
            question: current.choiceQuestion,
            remainingMs:
              current.choiceMode === 'continue'
                ? Math.max(0, sceneDuration(project, current) - route.positionMs)
                : 0,
            options: route.choices.map(({ choice, enabled }) => ({
              id: choice.id,
              label: choice.label,
              lockedHint: choice.lockedText,
              enabled,
            })),
          }
        : undefined,
  };
}

export function registerScreenplayTools(registry: ToolRegistry) {
  registry.register({
    name: 'read_screenplay',
    label: '读取剧本正文',
    group: 'design',
    mode: 'read',
    description:
      'node 按真实节点 ID 分页读取完整演出正文。route 从作品入口按真实玩家选项 choiceIds 或选择与等待 steps 模拟路线，返回目标章的节点顺序、正文版本、缺稿、自动去向和待选项。章首预览从默认状态开始；跨章条件请从作品入口读取。遇到 nextOffset 续读。',
    schema: z.discriminatedUnion('action', [
      z.strictObject({ action: z.literal('node'), nodeId: id, ...page }),
      z.strictObject({
        action: z.literal('route'),
        chapterId: id,
        choiceIds: routeSimulationFields.choiceIds,
        steps: routeSimulationFields.steps,
        fromChapter: z.boolean().default(false),
        ...page,
      }),
    ]),
    execute: ({ project, readPageCharacters }, input) => {
      const { offset, limit } = input;
      if (input.action === 'route') {
        if (input.steps && input.choiceIds.length)
          throw new Error('请使用 steps 或 choiceIds 其中一种。');
        const { rows, ...state } = readScreenplayRoute(
          project,
          input.chapterId,
          input.steps ?? input.choiceIds.map((choiceId) => ({ action: 'choose', choiceId })),
          input.fromChapter,
        );
        const entries = rows.slice(offset, offset + limit).map(({ entry, endingText, ...row }) => ({
          ...row,
          hasScreenplay: Boolean(entry),
          version: entry?.version,
        }));
        const end = offset + entries.length;
        return {
          ok: true,
          summary: '已读取该路线的正文目录',
          data: {
            ...state,
            entries,
            total: rows.length,
            nextOffset: end < rows.length ? end : null,
          },
        };
      }
      const node = project.scenes.find(({ id }) => id === input.nodeId);
      if (!node) throw new Error('找不到指定节点。');
      const entry = project.screenplays?.find(({ id }) => id === input.nodeId);
      const blocks = entry?.blocks ?? [];
      const result = [];
      let remaining = Math.min(readPageCharacters ?? 12000, 12000) - 650;
      for (const block of blocks.slice(offset, offset + limit)) {
        remaining -= JSON.stringify(block).length;
        if (remaining < 0 && result.length) break;
        result.push(block);
      }
      const end = offset + result.length;
      return {
        ok: true,
        summary: entry ? `读取「${node.title}」的剧本正文` : `「${node.title}」尚未编写剧本正文`,
        data: {
          nodeId: node.id,
          title: node.title,
          kind: node.kind,
          version: entry?.version,
          offset,
          blocks: result,
          total: blocks.length,
          nextOffset: end < blocks.length ? end : null,
        },
      };
    },
  });
  registry.register({
    name: 'edit_screenplay',
    label: '保存节点剧本正文',
    group: 'design',
    mode: 'write',
    description:
      '按真实 video 节点 ID 保存完整、有序的动作 action、对白 dialogue、独白 monologue 和声音 sound 段落。对白和独白必填 speaker。按节点更新作者稿，分支、notes、玩家文字和镜头独立保存。',
    schema: z.strictObject({ nodeId: id, blocks: screenplayBlocks }),
    execute: ({ project }, { nodeId, blocks }) => {
      const { version } = updateScreenplay(project, nodeId, blocks);
      return {
        ok: true,
        summary: '已保存节点剧本正文',
        nodeIds: [nodeId],
        data: { nodeId, version, needsReview: screenplayNeedsReview(project, nodeId, version) },
      };
    },
  });
}
