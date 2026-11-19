import { z } from 'zod';
import type { ToolResult } from '../types';
import type { ToolRegistry } from './registry';

const PAGE_CHARACTERS = 20000;
type BatchRow = ToolResult & { index: number; tool: string };

function batchPage(total: number, offset: number, rows: BatchRow[]) {
  const nextOffset = offset + rows.length < total ? offset + rows.length : null;
  const errors = rows.filter((row) => !row.ok).length;
  const reused = rows.filter(
    ({ data }) => (data as { reused?: boolean } | undefined)?.reused,
  ).length;
  const truncatedItems = rows.flatMap(({ index, tool, data }) => {
    const item = data as { truncated?: boolean; originalCharacters?: number } | undefined;
    return item?.truncated && typeof item.originalCharacters === 'number'
      ? [{ index, tool, originalCharacters: item.originalCharacters }]
      : [];
  });
  return {
    ok: true,
    summary:
      '合并读取 ' +
      rows.length +
      ' 项' +
      (reused ? '，' + reused + ' 项已在当前上下文' : '') +
      (errors ? '，' + errors + ' 项需要修正' : '') +
      (truncatedItems.length ? '，' + truncatedItems.length + ' 项超出单页预算' : ''),
    data: {
      total,
      offset,
      nextOffset,
      truncated: nextOffset !== null || truncatedItems.length > 0,
      truncatedItems,
      detailHint: truncatedItems.length
        ? '按 index 找到原请求，缩小该项的 limit 或分段读取。nextOffset 用于尚未返回的批量项。'
        : undefined,
      results: rows,
    },
  };
}

export function registerBatchReadTool(registry: ToolRegistry) {
  const readable = registry
    .list()
    .filter((tool) => tool.mode === 'read' && tool.group !== 'workflow');
  registry.register({
    name: 'read_batch',
    label: '合并读取',
    group: 'context',
    mode: 'read',
    maxResultCharacters: PAGE_CHARACTERS,
    description: `每次合并 2–8 项独立读取，每项使用 tool 和 args。例如 {"requests":[{"tool":"read_project","args":{}},{"tool":"list_game_data","args":{"kind":"variable"}}]}。单项或依赖上一次结果时直接调用对应工具。每页最多 ${PAGE_CHARACTERS} 字符，剩余上下文较小时自动缩小。nextOffset 非空时用相同 requests 续读；truncatedItems 标出单项超预算的查询。`,
    schema: z.object({
      requests: z
        .array(
          z.object({
            tool: z.enum(readable.map((tool) => tool.name)),
            args: z
              .record(z.string(), z.unknown())
              .default({})
              .describe(
                '使用该读取工具原有的参数对象。例如 read_story 用 {"action":"read","nodeId":"真实节点ID"}。',
              ),
          }),
        )
        .min(2)
        .max(8),
      offset: z.number().int().min(0).max(8).default(0),
    }),
    execute(context, { requests, offset }) {
      const pageCharacters = Math.min(
        PAGE_CHARACTERS,
        context.readPageCharacters ?? PAGE_CHARACTERS,
      );
      let rows: BatchRow[] = [];
      const cached = new Map<string, ToolResult>();
      const itemContext = {
        ...context,
        readPageCharacters:
          pageCharacters - JSON.stringify(batchPage(requests.length, offset, [])).length - 128,
      };
      for (let index = offset; index < requests.length; index++) {
        const { tool, args } = requests[index];
        const argumentsJson = JSON.stringify(
          Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))),
        );
        const key = tool + ':' + argumentsJson;
        const result = cached.get(key) ?? registry.execute(tool, argumentsJson, itemContext);
        cached.set(key, result);
        const reply = context.reuseBatchRead?.(tool, args, result) ?? result;
        const row = { index, tool, ...reply };
        const candidate = [...rows, row];
        if (
          JSON.stringify(batchPage(requests.length, offset, candidate)).length <= pageCharacters
        ) {
          rows = candidate;
        } else {
          if (rows.length) break;
          rows.push({
            index,
            tool,
            ok: result.ok,
            summary: result.summary.slice(0, 300),
            data: { truncated: true, originalCharacters: JSON.stringify(row).length },
          });
        }
      }
      return batchPage(requests.length, offset, rows);
    },
  });
}
