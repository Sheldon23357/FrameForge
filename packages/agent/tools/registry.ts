import { z } from 'zod';
import { parseProject, storyStartId } from '../../domain/schema';
import type { ToolContext, ToolResult, ToolSpec } from '../types';

function explainIssues(issues: readonly z.core.$ZodIssue[], prefix: PropertyKey[] = []): string[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors.length) {
      // Report the closest variant so one malformed field does not collapse into “Invalid input”.
      const closest = issue.errors.reduce((a, b) => (b.length < a.length ? b : a));
      return explainIssues(closest, path);
    }
    return `${path.map(String).join('.')} ${issue.message}`.trim();
  });
}

interface ToolDefinitionBase<T> {
  name: string;
  label: string;
  description: string;
  group: string;
  category?: string;
  mode: 'read' | 'write' | 'view';
  maxResultCharacters?: number;
  schema: z.ZodType<T>;
  modelSchema?: z.ZodType;
  normalizeArguments?(args: unknown): unknown;
  previousWrite?(args: T): { name: string; args: unknown } | undefined;
}
export type ToolDefinition<T = unknown> = ToolDefinitionBase<T> &
  (
    | { execute(context: ToolContext, args: T): ToolResult; executeAsync?: never }
    | { execute?: never; executeAsync(context: ToolContext, args: T): Promise<ToolResult> }
  );
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<any>>();
  register<T>(tool: ToolDefinition<T>): this {
    if (this.tools.has(tool.name)) throw new Error(`重复工具：${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }
  combine(
    tool: Pick<
      ToolDefinition,
      'name' | 'label' | 'description' | 'category' | 'maxResultCharacters'
    >,
    actions: Record<string, string>,
    options?: { flat?: boolean; batch?: boolean; minBatchSize?: number },
  ): void {
    const operations = Object.entries(actions).map(([action, name]) => {
      const definition = this.tools.get(name);
      if (!definition) throw new Error(`未注册的工具：${name}`);
      return { action, definition };
    });
    const [first, ...rest] = operations;
    if (
      !first ||
      operations.some(
        ({ definition }) =>
          !definition.execute ||
          definition.mode !== first.definition.mode ||
          (first.definition.mode === 'write' && definition.group !== first.definition.group),
      )
    )
      throw new Error(`工具的执行权限不一致：${tool.name}`);
    const byAction = new Map(operations.map(({ action, definition }) => [action, definition]));
    const actionSchema = ({ action, definition }: (typeof operations)[number]) =>
      z.strictObject({
        action: z.literal(action),
        args: (definition.mode === 'read' && definition.schema.safeParse({}).success
          ? definition.schema.prefault({})
          : definition.schema
        ).describe(definition.description),
      });
    const flatActionSchema = ({ action, definition }: (typeof operations)[number]) => {
      if (!(definition.schema instanceof z.ZodObject))
        throw new Error(`工具 ${definition.name} 需要对象参数才能公开为扁平格式。`);
      return z
        .strictObject({ action: z.literal(action), ...definition.schema.shape })
        .describe(definition.description);
    };
    const singleSchema = z.discriminatedUnion('action', [
      actionSchema(first),
      ...rest.map(actionSchema),
    ]);
    const flatActions = options?.flat
      ? ([flatActionSchema(first), ...rest.map(flatActionSchema)] as const)
      : undefined;
    const minBatchSize = options?.minBatchSize ?? 2;
    const batchSchema = z.strictObject({
      action: z.literal('batch'),
      args: z.strictObject({ operations: z.array(z.unknown()).min(minBatchSize).max(8) }),
    });
    const modelBatchSchema =
      flatActions &&
      z.strictObject({
        action: z.literal('batch'),
        operations: z.array(z.discriminatedUnion('action', flatActions)).min(minBatchSize).max(8),
      });
    this.register({
      ...tool,
      mode: first.definition.mode,
      group: first.definition.group,
      schema: options?.batch ? z.union([singleSchema, batchSchema]) : singleSchema,
      modelSchema: flatActions
        ? z.discriminatedUnion('action', [
            ...flatActions,
            ...(options?.batch && modelBatchSchema ? [modelBatchSchema] : []),
          ])
        : undefined,
      normalizeArguments: options?.flat
        ? (input) => {
            if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
            const { action, ...fields } = input as Record<string, unknown>;
            const combined = 'args' in fields ? input : { action, args: fields };
            const normalizer =
              typeof action === 'string' ? byAction.get(action)?.normalizeArguments : undefined;
            if (!normalizer || Object.keys(combined).length !== 2) return combined;
            const { args } = combined as { args?: unknown };
            return { action, args: normalizer(args) };
          }
        : undefined,
      execute: (context, input) => {
        const { action, args } = input;
        if (!options?.batch || action !== 'batch')
          return byAction.get(action)!.execute!(context, args);

        return runWriteBatch(args.operations, '节点编辑', (operation) => {
          const name =
            operation && typeof operation === 'object' && 'action' in operation
              ? operation.action
              : undefined;
          return typeof name === 'string' && byAction.has(name)
            ? this.execute(tool.name, JSON.stringify(operation), context)
            : { ok: false, summary: '请使用单项编辑 action。' };
        });
      },
      previousWrite:
        first.definition.mode === 'write'
          ? ({ action, args }) => {
              const operation = byAction.get(action);
              return operation && { name: operation.name, args };
            }
          : undefined,
    });
    for (const { definition } of operations) this.tools.delete(definition.name);
  }
  get(name: string) {
    return this.tools.get(name);
  }
  list() {
    return [...this.tools.values()].map(({ name, label, description, mode, group, category }) => ({
      name,
      label,
      description,
      mode,
      group,
      category: category ?? group,
    }));
  }
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => {
      const schema = z.toJSONSchema(t.modelSchema ?? t.schema, { target: 'draft-7', io: 'input' });
      const { $schema: _version, ...parameters } = schema;
      return {
        name: t.name,
        description: t.description,
        parameters: { type: 'object', ...parameters },
      };
    });
  }
  execute(name: string, raw: string, context: ToolContext): ToolResult {
    return this.run(name, raw, context, false);
  }
  async executeAsync(name: string, raw: string, context: ToolContext): Promise<ToolResult> {
    return this.run(name, raw, context, true);
  }
  private run(name: string, raw: string, context: ToolContext, allowAsync: false): ToolResult;
  private run(
    name: string,
    raw: string,
    context: ToolContext,
    allowAsync: true,
  ): ToolResult | Promise<ToolResult>;
  private run(name: string, raw: string, context: ToolContext, allowAsync: boolean) {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, summary: `不存在工具 ${name}，请使用已注册的工具。` };
    if (tool.executeAsync && !allowAsync) return { ok: false, summary: '该工具需要异步运行。' };
    if (raw.length > 64000) return { ok: false, summary: '工具参数过大，请分批操作。' };
    let args: unknown;
    try {
      args = JSON.parse(raw);
      const depth = (v: unknown, n: number): void => {
        if (n > 30) throw new Error('参数嵌套过深');
        if (v && typeof v === 'object')
          for (const [key, value] of Object.entries(v)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key))
              throw new Error('参数包含保留字段');
            depth(value, n + 1);
          }
      };
      depth(args, 0);
    } catch {
      return { ok: false, summary: '工具参数必须是有效且嵌套深度不超过 30 层的 JSON 对象。' };
    }
    const parsed = tool.schema.safeParse(tool.normalizeArguments?.(args) ?? args);
    if (!parsed.success)
      return {
        ok: false,
        summary: `参数错误：${explainIssues(parsed.error.issues)
          .slice(0, 5)
          .map((issue) =>
            tool.modelSchema && args && typeof args === 'object' && !('args' in args)
              ? issue.replace(/^args\./, '')
              : issue,
          )
          .join('；')}`,
      };
    const candidate =
      tool.mode === 'write'
        ? { ...context, project: structuredClone(context.project), intents: [...context.intents] }
        : context;
    const finish = (result: ToolResult) => {
      if (result.ok && tool.mode === 'write') {
        candidate.project.startNodeId = storyStartId(candidate.project);
        context.project = parseProject(candidate.project);
        context.intents = candidate.intents;
      }
      return result;
    };
    const failure = (error: unknown): ToolResult => ({
      ok: false,
      summary:
        error instanceof z.ZodError
          ? `数据校验失败：${error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join('.')} ${i.message}`)
              .join('；')}`
          : error instanceof Error
            ? error.message
            : '工具执行失败。',
    });
    try {
      return tool.execute
        ? finish(tool.execute(candidate, parsed.data))
        : tool.executeAsync(candidate, parsed.data).then(finish).catch(failure);
    } catch (error) {
      return failure(error);
    }
  }
}
export function runWriteBatch(
  operations: unknown[],
  label: string,
  execute: (operation: unknown) => ToolResult,
): ToolResult {
  const results = operations.map((operation, index) => {
    const result = execute(operation);
    const data = result.data as { id?: string } | undefined;
    return {
      index,
      ok: result.ok,
      summary: result.summary.slice(0, 300),
      nodeIds: result.nodeIds?.slice(0, 8),
      id: data?.id,
    };
  });
  const succeeded = results.filter(({ ok }) => ok).length;
  const nodeIds = [...new Set(results.flatMap((result) => result.nodeIds ?? []))];
  return {
    ok: succeeded > 0,
    summary: `已完成 ${succeeded}/${results.length} 项${label}`,
    data: { results },
    ...(nodeIds.length ? { nodeIds } : {}),
  };
}

export function boundedResult(result: ToolResult, maxChars = 14000): ToolResult {
  const text = JSON.stringify(result.data ?? null);
  if (text.length <= maxChars) return result;
  return {
    ...result,
    data: {
      truncated: true,
      originalCharacters: text.length,
      preview: text.slice(0, Math.max(0, maxChars - 1000)),
      next: '请使用分页或指定 section 缩小读取范围，也可从本轮调用记录读取结果。',
    },
  };
}
