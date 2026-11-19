import type { ToolSpec } from './types';

const detailToolNames = new Set(['read_story', 'read_screenplay', 'read_batch', 'check_story']);

export function availableDuringFocusedRead(toolName: string) {
  return detailToolNames.has(toolName);
}

function nodeReadParameters(parameters: ToolSpec['parameters'], actions: ReadonlySet<string>) {
  const variants = (parameters.oneOf as Record<string, unknown>[] | undefined)?.filter((variant) =>
    actions.has(
      String((variant.properties as { action?: { const?: string } } | undefined)?.action?.const),
    ),
  );
  return variants?.length ? { type: 'object', oneOf: variants } : parameters;
}

const detailActions = new Set(['read', 'timeline', 'shot']);
const screenplayActions = new Set(['node']);

export function focusedReadSpec(spec: ToolSpec): ToolSpec {
  if (spec.name === 'read_story')
    return {
      ...spec,
      description:
        '按实际 ID 补查缺少的详情。read 查故事板、选项、备注或事件；timeline 查一条轨道；shot 查一张镜头卡。',
      parameters: nodeReadParameters(spec.parameters, detailActions),
    };
  if (spec.name === 'read_screenplay')
    return {
      ...spec,
      description: '按实际节点 ID 和 offset 补读剧本正文。根据 nextOffset 续页。',
      parameters: nodeReadParameters(spec.parameters, screenplayActions),
    };
  if (spec.name === 'read_batch')
    return {
      ...spec,
      description:
        '一次补查 2–8 个已知 ID 的详情。每项可用 read_story 的 read、timeline、shot 或 read_screenplay 的 node 操作，按各项 nextOffset 续页。',
    };
  return spec;
}

function isNodeRead(tool: string, query: Record<string, unknown>) {
  if (tool === 'read_screenplay')
    return (
      query.action === 'node' && typeof query.nodeId === 'string' && query.nodeId.trim() !== ''
    );
  if (tool !== 'read_story') return false;
  const args =
    query.args && typeof query.args === 'object' ? (query.args as Record<string, unknown>) : query;
  if (!detailActions.has(String(query.action))) return false;
  const id = query.action === 'shot' ? args.shotId : args.nodeId;
  return typeof id === 'string' && id.trim() !== '';
}

/** Query has already been normalized and validated against the registry schema. */
export function focusedReadError(toolName: string, query: Record<string, unknown>) {
  if (toolName === 'check_story') return;
  if (isNodeRead(toolName, query)) return;
  if (
    toolName === 'read_batch' &&
    Array.isArray(query.requests) &&
    query.requests.every(({ tool, args }) => isNodeRead(tool, args))
  )
    return;
  return '当前阶段只补查缺失的节点详情。用实际 ID 调用 read_story 的 read、timeline、shot 或 read_screenplay 的 node，多个已知 ID 可合并读取。节点清单、章节总览和连线扫描请使用已有工程工作区。';
}
