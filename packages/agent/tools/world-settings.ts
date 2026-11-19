import { z } from 'zod';
import { worldSettingFields, worldSettingSchema } from '../../domain/schema';
import {
  createWorldSetting,
  deleteWorldSetting,
  findWorldSetting,
  linkWorldSetting,
  matchesWorldSetting,
  updateWorldSetting,
} from '../../domain/world-settings';
import type { ToolRegistry } from './registry';
import {
  validateAgentWorldDescriptions,
  worldSoundGuide,
  worldVisualGuide,
} from '../world-setting-writing';

const id = z.string().min(1).max(160);
const kind = worldSettingSchema.shape.kind;
const authoredFields = worldSettingFields.extend({
  description: worldSettingFields.shape.description.describe(
    '角色交代身份、性格和典型行为，供形象与声音设计参考。场景交代用途、日常氛围和它在故事中的作用。',
  ),
  visual: worldSettingFields.shape.visual.describe(worldVisualGuide),
  sound: worldSettingFields.shape.sound.describe(worldSoundGuide),
});
const pagination = {
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(20).default(10),
};

export function registerWorldSettingTools(registry: ToolRegistry) {
  registry.register({
    name: 'read_world_settings',
    label: '查询角色与场景设定',
    group: 'story',
    category: 'world',
    mode: 'read',
    description:
      'list 按名称或设定内容、角色/场景类型、关联节点筛选，返回分页摘要和真实 settingId。read 按 settingId 读取完整设定、参考素材 ID 和分页的关联节点。',
    schema: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('list'),
        kind: kind.optional(),
        query: z.string().max(160).optional(),
        nodeId: id.optional(),
        ...pagination,
      }),
      z.object({ action: z.literal('read'), settingId: id, ...pagination }),
    ]),
    execute: ({ project }, args) => {
      const { offset, limit } = args;
      if (args.action === 'read') {
        const setting = findWorldSetting(project, args.settingId);
        const linked = project.scenes.filter((scene) => scene.settingIds?.includes(setting.id));
        return {
          ok: true,
          summary: `读取设定「${setting.name}」`,
          data: {
            setting,
            total: linked.length,
            offset,
            nextOffset: offset + limit < linked.length ? offset + limit : null,
            nodes: linked
              .slice(offset, offset + limit)
              .map(({ id, title, chapterId }) => ({ id, title, chapterId })),
          },
        };
      }
      const node = args.nodeId
        ? project.scenes.find((scene) => scene.id === args.nodeId)
        : undefined;
      if (args.nodeId && !node) throw new Error('找不到要查询的剧情节点。');
      const rows = (project.worldSettings ?? []).filter(
        (setting) =>
          (!args.kind || setting.kind === args.kind) &&
          (!node || node.settingIds?.includes(setting.id)) &&
          (!args.query || matchesWorldSetting(setting, args.query)),
      );
      return {
        ok: true,
        summary: `找到 ${rows.length} 条设定`,
        data: {
          total: rows.length,
          offset,
          nextOffset: offset + limit < rows.length ? offset + limit : null,
          settings: rows.slice(offset, offset + limit).map(({ id, kind, name, description }) => ({
            id,
            kind,
            name,
            descriptionPreview: description?.slice(0, 100),
            descriptionTruncated: (description?.length ?? 0) > 100,
          })),
        },
      };
    },
  });
  registry.register({
    name: 'edit_world_setting',
    label: '维护角色与场景设定',
    group: 'story',
    category: 'world',
    mode: 'write',
    description: `create 新建设定，update 按真实 settingId 修改字段，link 用真实 nodeIds 管理关联，delete 删除设定及其关联。visual 和 sound 填写可复用的设定。${worldVisualGuide}${worldSoundGuide}绘图补充要求单独写 imagePrompt。素材引用使用已导入的素材 ID，传 null 清除。用户可以在设定面板生成参考图和音频，或手动选择本地文件导入并关联。`,
    schema: z.discriminatedUnion('action', [
      authoredFields.extend({ action: z.literal('create'), kind }),
      z.object({ action: z.literal('update'), settingId: id, patch: authoredFields.partial() }),
      z.object({
        action: z.literal('link'),
        settingId: id,
        nodeIds: z.array(id).min(1).max(100),
        linked: z.boolean().default(true),
      }),
      z.object({ action: z.literal('delete'), settingId: id }),
    ]),
    execute: ({ project }, args) => {
      if (args.action === 'link') {
        linkWorldSetting(project, args.settingId, args.nodeIds, args.linked);
        return {
          ok: true,
          summary: args.linked ? '已关联剧情节点' : '已解除节点关联',
          data: { settingId: args.settingId },
          nodeIds: args.nodeIds,
        };
      }
      if (args.action === 'create') validateAgentWorldDescriptions(args.kind, args);
      if (args.action === 'update') {
        const previous = findWorldSetting(project, args.settingId);
        validateAgentWorldDescriptions(previous.kind, args.patch, previous);
      }
      const setting =
        args.action === 'create'
          ? createWorldSetting(project, args.kind, args)
          : args.action === 'update'
            ? updateWorldSetting(project, args.settingId, args.patch)
            : deleteWorldSetting(project, args.settingId);
      const verb = { create: '新建', update: '更新', delete: '删除' }[args.action];
      return {
        ok: true,
        summary: `${verb}设定「${setting.name}」`,
        data: { settingId: setting.id },
      };
    },
  });
}
