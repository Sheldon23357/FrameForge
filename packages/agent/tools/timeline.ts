import { z } from 'zod';
import {
  dialogueEndMs,
  editTimeline,
  nodeDuration,
  playerTextPlayback,
  stillClipsFor,
  timelineCommandSchema,
} from '../../domain/timeline';
import type { ToolRegistry } from './registry';

export function registerTimelineTools(r: ToolRegistry) {
  r.register({
    name: 'read_timeline',
    label: '读取节点时间线',
    group: 'story',
    category: 'timeline',
    mode: 'read',
    description:
      '按轨道、关键词分页检索节点的时间线，返回真实片段 ID、总时长和截断信息。静态分镜用 still 轨读取，音轨返回配音用途及配音结束时间。时间单位毫秒。',
    schema: z.object({
      nodeId: z.string(),
      track: z.enum(['video', 'still', 'audio']),
      query: z.string().max(200).optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(25).default(15),
    }),
    execute: (c, a) => {
      const s = c.project.scenes.find((s) => s.id === a.nodeId);
      if (!s || s.kind !== 'video') throw new Error('视频节点不存在。');
      const clips =
        a.track === 'still'
          ? stillClipsFor(c.project, s)
          : ((a.track === 'video' ? s.timeline?.videoClips : s.timeline?.audioClips) ?? []);
      const rows = clips.filter(
        (clip) =>
          !a.query ||
          `${clip.id} ${clip.assetId} ${c.project.assets.find((v) => v.id === clip.assetId)?.name}`
            .toLowerCase()
            .includes(a.query.toLowerCase()),
      );
      return {
        ok: true,
        summary: `读取「${s.title}」的时间线`,
        data: {
          nodeId: s.id,
          durationMs: nodeDuration(c.project, s),
          legacy: !s.timeline,
          legacyAssetId: !s.timeline ? s.assetId : undefined,
          stillAssetId:
            s.timeline?.stillAssetId ??
            (!s.timeline && c.project.assets.some((a) => a.id === s.assetId && a.type === 'image')
              ? s.assetId
              : undefined),
          dialogueEndMs: dialogueEndMs(s),
          total: rows.length,
          offset: a.offset,
          truncated: a.offset + a.limit < rows.length,
          clips: rows.slice(a.offset, a.offset + a.limit),
        },
      };
    },
  });
  r.register({
    name: 'edit_timeline',
    label: '编辑节点时间线',
    group: 'story',
    category: 'timeline',
    mode: 'write',
    description:
      'append_shot_frame 用 shotId 和 frame=first 或 last 按镜头时长把已绑定的图片追加到图片轨。add_stills 批量追加已导入图片，默认按文件名自然排序、每张 3000ms；sortByName=false 保留输入顺序。update_still 调整片段时长、图片或入场叠化（dissolveMs 为 0–500，0 硬切）。move/remove 支持视频或分镜，先用 read_story.timeline 获取 ID。set_still 可设置单张静态画面，或用 assetId=null 和 durationMs 设置占位场景时长。分镜轨与视频轨互斥。音频用 action=add、track=audio、assetId 及 role=dialogue、music 或 effect 添加，再用返回的 clipId 调用 update_audio。align_stills_to_dialogue 按比例调整全部分镜至最后一段配音结束；保留选项、事件和音轨时间。split_video 按源素材 sourceMs 分割。音频 startMs 相对节点开头，loop 循环裁剪区，fadeInMs/fadeOutMs 按整段计算，volume 为 0–1。时间单位毫秒。',
    schema: z.object({ nodeId: z.string().min(1), command: timelineCommandSchema }),
    execute: (c, a) => {
      const clipId = editTimeline(c.project, a.nodeId, a.command);
      const s = c.project.scenes.find((s) => s.id === a.nodeId)!;
      return {
        ok: true,
        summary: '已编辑节点时间线',
        nodeIds: [s.id],
        data: {
          nodeId: s.id,
          clipId: clipId || undefined,
          playerTextPlayback: playerTextPlayback(c.project, s),
          stillAssetId: s.timeline!.stillAssetId,
          durationMs: nodeDuration(c.project, s),
          stillCount: stillClipsFor(c.project, s).length,
          dialogueEndMs: dialogueEndMs(s),
          videoCount: s.timeline!.videoClips.length,
          audioCount: s.timeline!.audioClips.length,
        },
      };
    },
  });
}
