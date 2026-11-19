import { creativeIntentSchema } from '../intent';
import type { ToolRegistry } from './registry';

export function registerWorkflowTools(registry: ToolRegistry) {
  registry.register({
    name: 'set_task_scope',
    label: '设定本轮创作范围',
    group: 'workflow',
    mode: 'read',
    description:
      '普通工程编辑直接调用对应工具。需要续跑检查点、明确调整待办或原样保存现成正文时，用本工具，并放在同一批次首位。',
    schema: creativeIntentSchema,
    async executeAsync(context, intent) {
      if (!context.setCreativeScope) throw new Error('当前运行不能设置创作范围。');
      await context.setCreativeScope(intent);
      return { ok: true, summary: '本轮创作范围已校验。' };
    },
  });
}
