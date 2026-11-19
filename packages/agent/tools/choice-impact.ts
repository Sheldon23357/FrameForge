import { z } from 'zod';
import type { Choice, Condition, Effect, Project, Scene } from '../../domain/schema';
import type { ToolRegistry } from './registry';

const id = z.string().min(1).max(160);
const describeScene = ({ id, title, kind, chapterId }: Scene) => ({ id, title, kind, chapterId });

function effectKey(effect: Effect) {
  if ('variableId' in effect) return `variable:${effect.variableId}`;
  if ('itemId' in effect) return `item:${effect.itemId}`;
  return undefined;
}

function conditionKeys(condition: Condition): string[] {
  if ('children' in condition) return condition.children.flatMap(conditionKeys);
  if (condition.kind === 'not') return conditionKeys(condition.child);
  if (condition.kind === 'variable') return [`variable:${condition.variableId}`];
  if (condition.kind === 'item') return [`item:${condition.itemId}`];
  return [`visited:${condition.nodeId}`];
}

function describeChoice(choice: Choice, index: number) {
  return {
    id: choice.id,
    index,
    label: choice.label,
    targetId: choice.targetId,
  };
}

function page<T>(rows: T[], offset: number, limit: number) {
  const entries: T[] = [];
  let characters = 0;
  for (const row of rows.slice(offset, offset + limit)) {
    const size = JSON.stringify(row).length + 1;
    if (entries.length && characters + size > 7500) break;
    entries.push(row);
    characters += size;
  }
  const nextOffset = offset + entries.length < rows.length ? offset + entries.length : null;
  return { total: rows.length, offset, entries, nextOffset, truncated: nextOffset !== null };
}

function possibleChoices(node: Scene) {
  if (node.kind === 'ending') return [];
  const fallback =
    node.kind === 'branch'
      ? node.choices.findIndex(
          ({ condition }) => condition.kind === 'all' && !condition.children.length,
        )
      : -1;
  return fallback < 0 ? node.choices : node.choices.slice(0, fallback + 1);
}

function downstream(project: Project, targetId: string) {
  const nodes = new Map(project.scenes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const queue = [{ nodeId: targetId, distance: 0, viaNodeId: '', viaChoiceId: '' }];
  const result: { node: Scene; distance: number; viaNodeId: string; viaChoiceId: string }[] = [];
  for (let i = 0; i < queue.length; i++) {
    const { nodeId, distance, viaNodeId, viaChoiceId } = queue[i];
    const node = nodes.get(nodeId);
    if (!node || seen.has(nodeId)) continue;
    seen.add(nodeId);
    result.push({ node, distance, viaNodeId, viaChoiceId });
    if (node.kind === 'ending') continue;
    if (node.choices.length) {
      for (const choice of possibleChoices(node)) {
        if (choice.targetId && !seen.has(choice.targetId))
          queue.push({
            nodeId: choice.targetId,
            distance: distance + 1,
            viaNodeId: nodeId,
            viaChoiceId: choice.id,
          });
      }
    } else if (node.kind === 'video' && node.nextId && !seen.has(node.nextId)) {
      queue.push({
        nodeId: node.nextId,
        distance: distance + 1,
        viaNodeId: nodeId,
        viaChoiceId: '',
      });
    }
  }
  return result;
}

export function registerChoiceImpactTool(registry: ToolRegistry) {
  registry.register({
    name: 'inspect_choice_impact',
    label: '分析选项后续影响',
    group: 'analysis',
    category: 'choices',
    mode: 'read',
    description:
      '分析选项后续影响，优先用它定位路线和属性/道具影响。省略 nodeId 使用发送时唯一选中的节点。省略 choiceId 分页列出选项及跳转目标。指定实际 choiceId 后，可用 summary 查看跳转目标、下游节点和可能结局数。references 找从目标结构可达的条件引用和后续写入，routes 分页找路径节点及可能结局。支持关键词、offset、limit；结构可达不等于实测可达。',
    schema: z.object({
      nodeId: id.optional(),
      choiceId: id.optional(),
      section: z.enum(['references', 'routes', 'summary']).default('references'),
      query: z.string().trim().max(200).optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(12).default(6),
    }),
    execute: ({ project, selectedIds }, args) => {
      const nodeId = args.nodeId ?? (selectedIds.length === 1 ? selectedIds[0] : undefined);
      if (!nodeId) throw new Error('请选择一个节点，或指定实际 nodeId。');
      const node = project.scenes.find((scene) => scene.id === nodeId);
      if (!node) throw new Error('节点不存在，请使用实际 nodeId。');
      if (node.kind === 'ending') throw new Error('结局节点不会执行选择。');
      const source = describeScene(node);
      const query = args.query?.toLowerCase();
      const matches = (...values: string[]) =>
        !query || values.some((value) => value.toLowerCase().includes(query));
      if (!args.choiceId) {
        const rows = node.choices
          .map(describeChoice)
          .filter((choice) => matches(choice.id, choice.label, choice.targetId));
        return {
          ok: true,
          summary: `找到 ${rows.length} 个选项`,
          data: {
            source,
            section: 'choices',
            ...page(rows, args.offset, args.limit),
            retrieval:
              '指定 choiceId 查后续影响；read_story 的 read 操作（section=choices） 用 index 读取原始条件。',
          },
        };
      }
      const index = node.choices.findIndex((choice) => choice.id === args.choiceId);
      if (index < 0) throw new Error('该节点没有此选项，请先检索选项 ID。');
      const choice = node.choices[index];
      const reachable = downstream(project, choice.targetId);
      const info = {
        source,
        choice: describeChoice(choice, index),
        target: reachable[0] ? describeScene(reachable[0].node) : null,
        reachableCount: reachable.length,
        possibleEndingCount: reachable.filter(({ node }) => node.kind === 'ending').length,
        section: args.section,
        scope:
          '检查后续节点事件写入的属性/道具及目标节点的访问标记。结构可达包含条件尚未验证的路径；具体状态用 check_story 的 simulate 操作核实。',
        retrieval:
          'read_story 的 read 操作用 nodeId、section 与对应 index 分页读取原始条件和事件。',
      };
      if (args.section === 'summary') {
        return {
          ok: true,
          summary: `下游 ${info.reachableCount} 个节点，结构上可达 ${info.possibleEndingCount} 个结局`,
          data: info,
        };
      }
      if (args.section === 'routes') {
        const rows = reachable
          .filter(({ node }) => matches(node.id, node.title, node.chapterId))
          .map(({ node, ...step }) => ({
            ...describeScene(node),
            ...step,
            choiceCount: node.choices.length,
          }));
        return {
          ok: true,
          summary: `找到 ${rows.length} 个结构可达节点`,
          data: { ...info, ...page(rows, args.offset, args.limit) },
        };
      }
      const state = new Set(
        reachable.flatMap(({ node }) =>
          node.events.flatMap((event) =>
            event.effects.flatMap((effect) => effectKey(effect) ?? []),
          ),
        ),
      );
      if (choice.targetId) state.add(`visited:${choice.targetId}`);
      const relevant = (keys: string[]) => [...new Set(keys)].filter((key) => state.has(key));
      const rows = reachable.flatMap(({ node, distance }) => {
        const entries = possibleChoices(node).flatMap((entry, index) => {
          const reads = relevant(conditionKeys(entry.condition));
          return reads.length && matches(node.id, node.title, entry.label, entry.id, ...reads)
            ? [
                {
                  nodeId: node.id,
                  title: node.title,
                  distance,
                  section: 'choices',
                  index,
                  entryId: entry.id,
                  label: entry.label,
                  reads: reads.slice(0, 4),
                  writes: [] as string[],
                  readCount: reads.length,
                  writeCount: 0,
                },
              ]
            : [];
        });
        node.events.forEach((entry, index) => {
          if (node.kind !== 'video' && entry.trigger === 'time' && entry.atMs > 0) return;
          if (node.kind === 'ending' && entry.trigger === 'exit') return;
          if (node.kind !== 'video' && entry.trigger === 'complete') return;
          const writes = relevant(entry.effects.flatMap((effect) => effectKey(effect) ?? []));
          if (writes.length && matches(node.id, node.title, entry.name, entry.id, ...writes))
            entries.push({
              nodeId: node.id,
              title: node.title,
              distance,
              section: 'events',
              index,
              entryId: entry.id,
              label: entry.name.slice(0, 200),
              reads: [],
              writes: writes.slice(0, 4),
              readCount: 0,
              writeCount: writes.length,
            });
        });
        return entries;
      });
      return {
        ok: true,
        summary: `找到 ${rows.length} 处后续引用或写入`,
        data: { ...info, ...page(rows, args.offset, args.limit) },
      };
    },
  });
}
