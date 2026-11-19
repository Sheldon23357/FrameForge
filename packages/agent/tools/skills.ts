import { z } from 'zod';
import { skillNameSchema, skillReadSchema } from '../skills';
import type { SkillReadResult } from '../skills';
import type { ToolContext } from '../types';
import type { ToolRegistry } from './registry';

function recordSkill(context: ToolContext, data: SkillReadResult) {
  const identity = data.identity;
  if (identity && data.text && context.currentTurn) {
    const used = (context.currentTurn.skills ??= []);
    if (!used.some(({ name }) => name === identity.name)) used.push(identity);
  }
}

export function registerSkillTool(registry: ToolRegistry) {
  registry.register({
    name: 'read_skill',
    label: '读取本地技能',
    description:
      '只读查询本轮本地 Skill。search 按名称或用途检索，留空列出目录；open 按名称读取 SKILL.md；list_files 按关键词查找可读资料；read_file 读取 Skill 内的相对文件名。按 nextOffset 续页，truncated 表示还有内容。',
    group: 'context',
    mode: 'read',
    schema: skillReadSchema,
    async executeAsync(context, input) {
      if (!context.skills) return { ok: false, summary: '本轮没有可用的本地技能。' };
      const data = await context.skills.read(input);
      recordSkill(context, data);
      return {
        ok: true,
        summary:
          data.file && data.identity
            ? `读取 ${data.identity.name}/${data.file}`
            : '已查询技能资料。',
        data,
      };
    },
  });
  registry.register({
    name: 'read_skill_files',
    label: '合并读取技能文件',
    group: 'context',
    mode: 'read',
    maxResultCharacters: 32000,
    description:
      '一次读取同一技能的最多 5 份已知文件。name 填技能名，files 每项填 file 和可选 offset；SKILL.md 可与已知参考一起读取。每份结果用 nextOffset 续页。文件未知时先用 read_skill.open 找引用。',
    schema: z.strictObject({
      name: skillNameSchema,
      files: z
        .array(
          z.strictObject({
            file: z.string().min(1).max(300),
            offset: z.number().int().min(0).max(1_000_000).default(0),
          }),
        )
        .min(1)
        .max(5),
    }),
    async executeAsync(context, { name, files }) {
      const skills = context.skills;
      if (!skills) return { ok: false, summary: '本轮没有可用的本地技能。' };
      const unique = new Map(
        files.map(({ file, offset }) => [
          JSON.stringify([file.replaceAll('\\', '/'), offset]),
          { file, offset },
        ]),
      );
      const results = await Promise.all(
        [...unique.values()].map(async ({ file, offset }) => {
          try {
            const data = await skills.read({ action: 'read_file', name, file, offset });
            recordSkill(context, data);
            return { file, offset, ok: true, ...data };
          } catch (error) {
            return {
              file,
              offset,
              ok: false,
              message: error instanceof Error ? error.message : '读取失败。',
            };
          }
        }),
      );
      const count = results.filter(({ ok }) => ok).length;
      return {
        ok: count > 0,
        summary: `已读取 ${count}/${results.length} 份技能文件`,
        data: { results },
      };
    },
  });
}
