import { z } from 'zod';
import type { ToolRegistry } from './registry';

export function registerProjectVersionTools(registry: ToolRegistry) {
  registry.register({
    name: 'list_project_versions',
    label: '查看工程修改历史',
    group: '工程',
    category: 'project',
    mode: 'read',
    description:
      '分页查看本机工程版本的时间和改动摘要。可用关键词筛选。返回 versionId，供用户明确要求回退时使用。',
    schema: z.object({
      keyword: z.string().trim().max(100).default(''),
      offset: z.number().int().min(0).max(10000).default(0),
      limit: z.number().int().min(1).max(15).default(8),
    }),
    execute(context, { keyword, offset, limit }) {
      const term = keyword.toLowerCase();
      const versions = (context.versions ?? []).filter((entry) =>
        [entry.title, ...entry.details].join(' ').toLowerCase().includes(term),
      );
      const page = versions.slice(offset, offset + limit);
      return {
        ok: true,
        summary: '找到 ' + versions.length + ' 个工程版本',
        data: {
          total: versions.length,
          nextOffset: offset + page.length < versions.length ? offset + page.length : null,
          versions: page.map(({ id, ...entry }) => ({
            ...entry,
            versionId: id,
            current: id === context.versions?.[0]?.id,
          })),
        },
      };
    },
  });
  registry.register({
    name: 'restore_project_version',
    label: '回退工程版本',
    group: '工程',
    category: 'project',
    mode: 'write',
    description:
      '仅在用户明确要求回退时使用。使用 list_project_versions 返回的 versionId，回退会替换当前轮草稿，并在提交时写入一条可撤销的工程修改。',
    schema: z.object({ versionId: z.string().min(1).max(100) }),
    execute(context, { versionId }) {
      const entry = context.versions?.find((version) => version.id === versionId);
      if (!entry || !context.projectAtVersion) throw new Error('未找到指定的工程版本。');
      if (entry === context.versions?.[0]) return { ok: true, summary: '已是当前工程版本。' };
      context.project = context.projectAtVersion(versionId);
      return { ok: true, summary: '已在草稿中回退到 ' + entry.title };
    },
  });
}
