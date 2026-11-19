import { z } from 'zod';
import {
  formatFramePrompt,
  framePromptInput,
  shotImagePromptMaxLength,
} from '../../domain/image-request';
import { productionShotIssue } from '../../domain/production-shots';
import { productionShotFields, uid } from '../../domain/schema';
import type { ToolRegistry } from './registry';

const id = z.string().min(1).max(160);
const editableShotFields = productionShotFields
  .omit({ videoPrompt: true, videoModel: true })
  .extend({
    firstFramePrompt: framePromptInput.optional(),
    lastFramePrompt: framePromptInput.optional(),
  });
const shotAction = productionShotFields.shape.action;

export function registerProductionShotTools(registry: ToolRegistry) {
  registry.register({
    name: 'list_production_shots',
    label: '查询镜号',
    group: 'story',
    category: 'timeline',
    mode: 'read',
    description: '按章节 ID、节点 ID 或镜号关键词分页查询有序镜头摘要。',
    schema: z.strictObject({
      chapterId: id.optional(),
      nodeId: id.optional(),
      query: z.string().trim().max(120).default(''),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(25).default(15),
    }),
    execute: ({ project }, input) => {
      const shots = project.productionShots ?? [];
      if (input.chapterId && !project.chapters.some(({ id }) => id === input.chapterId))
        throw new Error('关联章节不存在。');
      if (input.nodeId && !project.scenes.some((node) => node.id === input.nodeId))
        throw new Error('关联节点不存在。');
      const chapterNodes = input.chapterId
        ? new Set(
            project.scenes
              .filter(({ chapterId }) => chapterId === input.chapterId)
              .map(({ id }) => id),
          )
        : undefined;
      const query = input.query.toLowerCase();
      const rows = shots.filter(
        (shot) =>
          (!input.nodeId || shot.nodeId === input.nodeId) &&
          (!chapterNodes || chapterNodes.has(shot.nodeId)) &&
          shot.label.toLowerCase().includes(query),
      );
      const end = input.offset + input.limit;
      return {
        ok: true,
        summary: `找到 ${rows.length} 个制作镜头`,
        data: {
          total: rows.length,
          offset: input.offset,
          nextOffset: end < rows.length ? end : null,
          truncated: end < rows.length,
          shots: rows.slice(input.offset, end).map(({ id, nodeId, label, durationMs }) => ({
            id,
            nodeId,
            label,
            durationMs,
          })),
        },
      };
    },
  });
  registry.register({
    name: 'read_production_shot',
    label: '读取镜头卡',
    group: 'story',
    mode: 'read',
    description:
      '用真实 shotId 读取时间线预览区的分镜详情。section=prompts 或 frames 读取画面提示词、尾帧提示词及对应素材 ID，video 读取已绑定的视频素材 ID。',
    schema: z.strictObject({
      shotId: id,
      section: z.enum(['details', 'prompts', 'frames', 'video']).default('details'),
    }),
    execute: ({ project }, input) => {
      const shot = project.productionShots?.find(({ id }) => id === input.shotId);
      if (!shot) throw new Error('制作镜头不存在，请先查询真实镜头 ID。');
      const {
        firstFramePrompt,
        lastFramePrompt,
        videoPrompt: _videoPrompt,
        videoModel: _videoModel,
        ...details
      } = shot;
      const identity = { id: shot.id, nodeId: shot.nodeId, label: shot.label };
      const frames = {
        firstFramePrompt,
        lastFramePrompt,
        firstFrameAssetId: shot.firstFrameAssetId,
        lastFrameAssetId: shot.lastFrameAssetId,
      };
      const video = { videoAssetId: shot.videoAssetId };
      const sections = {
        details,
        prompts: { ...identity, ...frames, ...video },
        frames: { ...identity, ...frames },
        video: { ...identity, ...video },
      };
      return {
        ok: true,
        summary: `读取镜头「${shot.label}」`,
        data: sections[input.section],
      };
    },
  });
  registry.register({
    name: 'edit_production_shot',
    label: '编辑制作镜头卡',
    group: 'story',
    category: 'timeline',
    mode: 'write',
    description: `新建传 action=create 和真实 nodeId，镜头动作描述填 shotAction。更新传 action=update、真实 shotId 和 patch，动作描述填 patch.action。删除传 action=delete 和真实 shotId。settingIds 保存本镜使用的设定，传空数组表示本镜不挂设定图。镜号 label 在节点内唯一，index 是从 0 起的镜序，durationMs 是镜长。新写画面提示词 firstFramePrompt 或尾帧提示词 lastFramePrompt 时，用结构化对象描述同一静止瞬间：framing、space、subject、lighting 必填，references、exclusions 按需填写。默认中文，按实际挂图写参考用途。字符串可沿用旧文本或用户原文，传空字符串清除，每帧最多 ${shotImagePromptMaxLength} 字符。素材 ID 使用已导入的图片或视频，传 null 清空关联。`,
    normalizeArguments(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
      const input = raw as Record<string, unknown>;
      const { action, shotId, nodeId, label } = input;
      if (
        action === 'update' &&
        input.patch &&
        typeof input.patch === 'object' &&
        !Array.isArray(input.patch)
      ) {
        const { shotId: nestedId, ...patch } = input.patch as Record<string, unknown>;
        if (typeof nestedId === 'string' && (shotId === undefined || shotId === nestedId))
          return { ...input, shotId: nestedId, patch };
      }
      // Older assistants sometimes put the shot's action text in the operation discriminator.
      if (
        typeof action === 'string' &&
        action.length >= 8 &&
        /[\p{Script=Han}\s]/u.test(action) &&
        typeof nodeId === 'string' &&
        typeof label === 'string' &&
        shotId === undefined &&
        input.shotAction === undefined &&
        shotAction.safeParse(action).success
      )
        return { ...input, action: 'create', shotAction: action };
      return raw;
    },
    schema: z.discriminatedUnion('action', [
      editableShotFields
        .omit({ action: true })
        .extend({
          action: z.literal('create'),
          shotAction: shotAction.describe('本镜的可见动作，action 字段仍固定为 create。'),
          nodeId: id,
          index: z.number().int().nonnegative().optional(),
        })
        .strict(),
      z.strictObject({
        action: z.literal('update'),
        shotId: id,
        patch: editableShotFields.partial().strict(),
        index: z.number().int().nonnegative().optional(),
      }),
      z.strictObject({ action: z.literal('delete'), shotId: id }),
    ]),
    execute: ({ project, screenplaySourceVersion }, input) => {
      const shots = project.productionShots ?? [];
      const previous =
        input.action === 'create' ? undefined : shots.find(({ id }) => id === input.shotId);
      if (input.action !== 'create' && !previous) throw new Error('制作镜头不存在。');
      if (input.action === 'delete') {
        const remaining = shots.filter(({ id }) => id !== input.shotId);
        if (remaining.length) project.productionShots = remaining;
        else delete project.productionShots;
        return { ok: true, summary: '已删除制作镜头卡', nodeIds: [previous!.nodeId] };
      }
      const { firstFramePrompt, lastFramePrompt, ...fields } =
        input.action === 'create' ? input : input.patch;
      const prompts = {
        ...(firstFramePrompt !== undefined && {
          firstFramePrompt: formatFramePrompt(firstFramePrompt),
        }),
        ...(lastFramePrompt !== undefined && {
          lastFramePrompt: formatFramePrompt(lastFramePrompt),
        }),
      };
      const shot =
        input.action === 'create'
          ? {
              ...productionShotFields.parse({ ...fields, ...prompts, action: input.shotAction }),
              id: uid('shot'),
              nodeId: input.nodeId,
            }
          : { ...previous!, ...fields, ...prompts };
      const version = screenplaySourceVersion?.(shot.nodeId);
      if (version) Object.assign(shot, { screenplayVersion: version });
      const issue = productionShotIssue(
        shot,
        new Map(project.scenes.map((node) => [node.id, node])),
        new Map(project.assets.map((asset) => [asset.id, asset])),
        new Set(project.worldSettings?.map(({ id }) => id)),
      );
      if (issue) throw new Error(issue);
      if (
        shots.some(
          (row) =>
            row.id !== shot.id &&
            row.nodeId === shot.nodeId &&
            row.label.toLowerCase() === shot.label.toLowerCase(),
        )
      )
        throw new Error('同一节点已有此镜号。');
      if (previous && input.index === undefined) shots[shots.indexOf(previous)] = shot;
      else {
        if (previous) shots.splice(shots.indexOf(previous), 1);
        const positions = shots.flatMap((row, position) =>
          row.nodeId === shot.nodeId ? [position] : [],
        );
        const position =
          positions[input.index ?? positions.length] ??
          (positions.length ? positions[positions.length - 1] + 1 : shots.length);
        shots.splice(position, 0, shot);
      }
      project.productionShots = shots;
      return {
        ok: true,
        summary: `已保存镜头「${shot.label}」`,
        data: { shotId: shot.id, nodeId: shot.nodeId, label: shot.label },
        nodeIds: [shot.nodeId],
      };
    },
  });
}
