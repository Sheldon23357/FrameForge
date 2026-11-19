import { z } from 'zod';
import type { ToolRegistry } from './registry';
export function registerHistoryTools(r: ToolRegistry) {
  r.register({
    name: 'search_history',
    label: '检索历史对话',
    group: 'context',
    mode: 'read',
    description:
      '从本对话完整日志中检索消息，即使已经压缩为历史记忆也能检索。空格分隔多个关键词，匹配任一个并按命中数排序；返回 matchedTerms 和真实 turnId，详情可继续分页读取。无结果时缩短关键词重试。',
    schema: z.object({
      query: z.string().max(300).optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    execute: (c, a) => {
      const terms = [...new Set((a.query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean))];
      const rows = (c.history ?? [])
        .map((t, index) => {
          const text = `${t.user}\n${t.assistant}`.toLowerCase();
          return { turn: t, index, matchedTerms: terms.filter((term) => text.includes(term)) };
        })
        .filter((row) => !terms.length || row.matchedTerms.length > 0)
        .sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || b.index - a.index);
      return {
        ok: true,
        summary: `找到 ${rows.length} 轮历史对话`,
        data: {
          total: rows.length,
          matchMode: 'any_keyword',
          offset: a.offset,
          truncated: a.offset + a.limit < rows.length,
          turns: rows.slice(a.offset, a.offset + a.limit).map(({ turn: t, matchedTerms }) => ({
            turnId: t.id,
            matchedTerms,
            user: t.user.slice(0, 1000),
            assistant: t.assistant.slice(0, 1000),
            status: t.status,
            committed: t.committed,
            reverted: t.reverted,
            toolCount: t.traces.length,
          })),
        },
      };
    },
  });
  r.register({
    name: 'read_history_turn',
    label: '读取历史记录',
    group: 'context',
    mode: 'read',
    description:
      '按 turnId 分页读取历史消息或工具记录。本轮只返回已结束的调用。tools 的 offset 为原调用序号；tool_result 指定 traceIndex 后按字符分页。',
    schema: z.object({
      turnId: z.string(),
      section: z.enum(['messages', 'tools', 'tool_result']).default('messages'),
      traceIndex: z.number().int().nonnegative().optional(),
      offset: z.number().int().nonnegative().default(0),
    }),
    execute: (c, a) => {
      const isCurrent = c.currentTurn?.id === a.turnId;
      const t = isCurrent ? c.currentTurn : c.history?.find((t) => t.id === a.turnId);
      if (!t) throw new Error('历史轮次不存在。');
      if (a.section === 'tools') {
        // The harness appends the live call before executing it. Exclude it and
        // detach the page so recording this result cannot change its contents.
        const total = t.traces.length - Number(isCurrent && t.traces.at(-1)?.status === 'running');
        const end = a.offset + 3;
        return {
          ok: true,
          summary: '读取历史记录',
          data: {
            total,
            nextOffset: end < total ? end : null,
            traces: structuredClone(t.traces.slice(a.offset, Math.min(end, total))),
          },
        };
      }
      const trace = a.traceIndex === undefined ? undefined : t.traces[a.traceIndex];
      if (a.section === 'tool_result' && !trace?.result) throw new Error('指定的工具结果不存在。');
      const text =
        a.section === 'tool_result'
          ? JSON.stringify(trace)
          : JSON.stringify({
              user: t.user,
              assistant: t.assistant,
              error: t.error,
              committed: t.committed,
              reverted: t.reverted,
            });
      return {
        ok: true,
        summary: '读取历史记录',
        data: {
          totalCharacters: text.length,
          text: text.slice(a.offset, a.offset + 6000),
          nextOffset: a.offset + 6000 < text.length ? a.offset + 6000 : null,
        },
      };
    },
  });
}
