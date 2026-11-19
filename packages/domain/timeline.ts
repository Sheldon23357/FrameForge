import { z } from 'zod';
import {
  audioClipSchema,
  stillClipSchema,
  type StillClip,
  videoClipSchema,
  uid,
  type Project,
  type Scene,
  type Timeline,
} from './schema';

function hasVisualMedia(s: Scene) {
  return s.timeline
    ? s.timeline.videoClips.length || s.timeline.stillClips?.length || s.timeline.stillAssetId
    : s.assetId;
}

export function activeStoryboard(s: Scene) {
  if (s.kind !== 'video' || !s.storyboardPages?.length || hasVisualMedia(s)) return undefined;
  return s.storyboardPages;
}

export function storyboardOverlayPages(p: Project, s: Scene) {
  const pages = s.storyboardPages;
  if (s.kind !== 'video' || !s.storyboardOverlay || !pages?.length || !hasVisualMedia(s))
    return undefined;
  const totalMs = pages.reduce((sum, page) => sum + page.durationMs, 0);
  const scale = Math.min(1, nodeDuration(p, s) / totalMs);
  return scale === 1
    ? pages
    : pages.map((page) => ({ ...page, durationMs: page.durationMs * scale }));
}

export const playerTextLabels = {
  empty: '未填写',
  paged: '分页播放',
  overlay: '叠在画面上',
  hidden: '有画面时隐藏',
} as const;

export function playerTextPlayback(project: Project, scene: Scene) {
  const paged = activeStoryboard(scene);
  const overlay = storyboardOverlayPages(project, scene);
  const mode = paged
    ? 'paged'
    : overlay
      ? 'overlay'
      : scene.storyboardPages?.length
        ? 'hidden'
        : 'empty';
  const authoredDurationMs = (scene.storyboardPages ?? []).reduce(
    (sum, page) => sum + page.durationMs,
    0,
  );
  const durationMs = nodeDuration(project, scene);
  const compressed = !!overlay && authoredDurationMs > durationMs;
  const effectiveDurationMs = compressed ? durationMs : paged || overlay ? authoredDurationMs : 0;
  const choiceAtMs = scene.choices.length
    ? Math.min(scene.choicesAtMs ?? durationMs, durationMs)
    : null;
  return {
    mode,
    authoredDurationMs,
    effectiveDurationMs,
    compressed,
    choiceAtMs,
    choiceBeforeTextEnd: choiceAtMs !== null && choiceAtMs < effectiveDurationMs,
  } as const;
}

export function storyboardAt(pages: NonNullable<Scene['storyboardPages']>, positionMs: number) {
  let endMs = 0;
  return pages.findIndex((page, index) => {
    endMs += page.durationMs;
    return positionMs < endMs || index === pages.length - 1;
  });
}

/** Visual segments are contiguous; audio offsets are relative to the entire node. */
export function nodeDuration(p: Project, s: Scene): number {
  if (s.timeline?.videoClips.length)
    return s.timeline.videoClips.reduce((sum, c) => sum + c.trimEndMs - c.trimStartMs, 0);
  if (s.timeline?.stillClips?.length)
    return s.timeline.stillClips.reduce((sum, clip) => sum + clip.durationMs, 0);
  const storyboard = activeStoryboard(s);
  if (storyboard) return storyboard.reduce((sum, page) => sum + page.durationMs, 0);
  const asset = p.assets.find((a) => a.id === s.assetId);
  return Math.max(
    1,
    s.timeline
      ? s.durationMs
      : (s.trimEndMs ?? (asset?.durationMs || s.durationMs)) - s.trimStartMs,
  );
}
export function stillClipsFor(p: Project, s: Scene): StillClip[] {
  if (s.timeline?.stillClips?.length) return s.timeline.stillClips;
  const assetId =
    s.timeline?.stillAssetId ??
    (!s.timeline && p.assets.some((asset) => asset.id === s.assetId && asset.type === 'image')
      ? s.assetId
      : undefined);
  return assetId ? [{ id: 'still:single', assetId, durationMs: nodeDuration(p, s) }] : [];
}
export function stillAt(clips: StillClip[], positionMs: number) {
  let startMs = 0;
  for (const [index, clip] of clips.entries()) {
    const endMs = startMs + clip.durationMs;
    if (positionMs < endMs || index === clips.length - 1) {
      const dissolveMs = Math.min(clip.dissolveMs ?? 0, clip.durationMs);
      const mix = dissolveMs ? Math.min(1, Math.max(0, (positionMs - startMs) / dissolveMs)) : 1;
      return {
        clip,
        endMs,
        next: clips[index + 1],
        previous: mix < 1 ? clips[index - 1] : undefined,
        mix,
      };
    }
    startMs = endMs;
  }
}
export function dialogueEndMs(s: Scene): number {
  return (s.timeline?.audioClips ?? []).reduce(
    (end, clip) => (clip.role === 'dialogue' ? Math.max(end, clip.startMs + clip.durationMs) : end),
    0,
  );
}
export function videoAt(s: Scene, positionMs: number) {
  let startMs = 0;
  for (const [index, clip] of (s.timeline?.videoClips ?? []).entries()) {
    const endMs = startMs + clip.trimEndMs - clip.trimStartMs;
    if (positionMs < endMs || index === s.timeline!.videoClips.length - 1)
      return {
        clip,
        startMs,
        endMs,
        sourceMs: clip.trimStartMs + Math.max(0, Math.min(positionMs - startMs, endMs - startMs)),
      };
    startMs = endMs;
  }
  return undefined;
}
export function audioSourceMs(
  clip: Timeline['audioClips'][number],
  positionMs: number,
): number | undefined {
  const elapsed = positionMs - clip.startMs;
  const length = clip.trimEndMs - clip.trimStartMs;
  if (elapsed < 0 || elapsed >= clip.durationMs || (!clip.loop && elapsed >= length))
    return undefined;
  return clip.trimStartMs + (clip.loop ? elapsed % length : elapsed);
}
/** Fades follow the whole clip, including repeats, and resume at saved node time. */
export function audioVolumeAt(clip: Timeline['audioClips'][number], positionMs: number): number {
  if (audioSourceMs(clip, positionMs) === undefined) return 0;
  const elapsed = positionMs - clip.startMs;
  const duration = clip.loop
    ? clip.durationMs
    : Math.min(clip.durationMs, clip.trimEndMs - clip.trimStartMs);
  const ease = (value: number) => {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  };
  const fadeIn = Math.min(duration, clip.fadeInMs ?? 0);
  const fadeOut = Math.min(duration, clip.fadeOutMs ?? 0);
  return (
    clip.volume *
    (fadeIn ? ease(elapsed / fadeIn) : 1) *
    (fadeOut ? ease((duration - elapsed) / fadeOut) : 1)
  );
}
export function timelineIssues(p: Project, s: Scene): string[] {
  if (!s.timeline) return [];
  if (s.kind !== 'video') return ['只有视频节点可以使用时间线。'];
  const issues: string[] = [];
  const { stillAssetId, stillClips } = s.timeline;
  if (stillAssetId || stillClips?.length) {
    if (s.timeline.videoClips.length) issues.push('静态画面和视频片段不能同时使用。');
    if (stillAssetId && stillClips?.length) issues.push('单张静态画面和分镜轨不能同时使用。');
    const imageIds = new Set(
      p.assets.filter((asset) => asset.type === 'image').map((asset) => asset.id),
    );
    if (stillClipsFor(p, s).some((clip) => !imageIds.has(clip.assetId)))
      issues.push('静态画面引用了不存在或类型错误的图片。');
  }
  for (const [kind, clips] of [
    ['video', s.timeline.videoClips],
    ['audio', s.timeline.audioClips],
  ] as const) {
    for (const clip of clips) {
      const asset = p.assets.find((a) => a.id === clip.assetId);
      if (!asset || asset.type !== kind)
        issues.push(`${kind === 'video' ? '视频' : 'BGM'}片段引用了不存在或类型错误的素材。`);
      if (clip.trimStartMs >= clip.trimEndMs) issues.push('时间线素材入点必须早于出点。');
      if (asset?.durationMs && clip.trimEndMs > asset.durationMs)
        issues.push('时间线素材出点超出了源素材长度。');
      if ('loop' in clip && !clip.loop && clip.durationMs > clip.trimEndMs - clip.trimStartMs)
        issues.push('未循环的 BGM 播放时长不能超过裁剪后的素材长度。');
    }
  }
  return [...new Set(issues)];
}
export function editableTimeline(p: Project, s: Scene): Timeline {
  if (s.timeline) return structuredClone(s.timeline);
  const asset = p.assets.find((a) => a.id === s.assetId);
  if (asset?.type === 'image') return { stillAssetId: asset.id, videoClips: [], audioClips: [] };
  if (asset?.type === 'audio') throw new Error('请为节点绑定视频或图片。');
  return {
    videoClips: asset
      ? [
          {
            id: uid('clip'),
            assetId: asset.id,
            trimStartMs: s.trimStartMs,
            trimEndMs: s.trimEndMs ?? (asset.durationMs || s.durationMs),
            volume: 1,
          },
        ]
      : [],
    audioClips: [],
  };
}
const clipId = z.string().min(1).max(160);
const stillDuration = z.number().finite().int().positive();
export const timelineCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add'),
    track: z.enum(['video', 'audio']),
    assetId: clipId,
    role: audioClipSchema.shape.role,
  }),
  z.object({
    action: z.literal('set_still'),
    assetId: clipId.nullable().describe('已导入图片的 ID；null 移除静态画面。'),
    durationMs: z
      .number()
      .finite()
      .positive()
      .optional()
      .describe('静态画面或占位场景的时长，单位毫秒。'),
  }),
  z.object({
    action: z.literal('add_stills'),
    assetIds: z.array(clipId).min(1).max(500),
    durationMs: stillDuration.default(3000),
    sortByName: z.boolean().default(true),
  }),
  z.object({
    action: z.literal('append_shot_frame'),
    shotId: clipId,
    frame: z.enum(['first', 'last']),
  }),
  z.object({
    action: z.literal('update_still'),
    clipId,
    patch: stillClipSchema.pick({ assetId: true, dissolveMs: true }).partial().extend({
      durationMs: stillDuration.optional(),
    }),
  }),
  z.object({ action: z.literal('align_stills_to_dialogue') }),
  z.object({
    action: z.literal('update_video'),
    clipId,
    patch: videoClipSchema
      .omit({ id: true })
      .partial()
      .extend({ volume: z.number().min(0).max(1).optional() }),
  }),
  z.object({
    action: z.literal('update_audio'),
    clipId,
    patch: audioClipSchema
      .omit({ id: true })
      .partial()
      .extend({ volume: z.number().min(0).max(1).optional(), loop: z.boolean().optional() }),
  }),
  z.object({ action: z.literal('remove'), clipId }),
  z.object({ action: z.literal('move'), clipId, index: z.number().int().nonnegative() }),
  z.object({ action: z.literal('split_video'), clipId, sourceMs: z.number().finite().positive() }),
]);
export type TimelineCommand = z.input<typeof timelineCommandSchema>;
/** Shared command for UI and Agent. Validate before publishing a candidate. */
export function editTimeline(p: Project, nodeId: string, input: TimelineCommand): string {
  const command = timelineCommandSchema.parse(input);
  const s = p.scenes.find((n) => n.id === nodeId);
  if (!s || s.kind !== 'video') throw new Error('请选择有效的视频节点。');
  const timeline = editableTimeline(p, s);
  const stills = stillClipsFor(p, s);
  let durationMs = stills.length ? nodeDuration(p, s) : s.durationMs;
  let resultId = '';
  const saveStills = (clips: StillClip[]) => {
    delete timeline.stillAssetId;
    timeline.stillClips = clips.length ? clips : undefined;
    if (clips.length) durationMs = clips.reduce((sum, clip) => sum + clip.durationMs, 0);
  };
  if (command.action === 'set_still') {
    if (timeline.videoClips.length) throw new Error('请先移除视频片段，再设置静态画面。');
    if (timeline.stillClips?.length) throw new Error('请使用分镜片段命令编辑已有分镜。');
    if (command.assetId) timeline.stillAssetId = command.assetId;
    else delete timeline.stillAssetId;
    durationMs = command.durationMs ?? durationMs;
  } else if (command.action === 'append_shot_frame') {
    if (timeline.videoClips.length) throw new Error('请先移除视频片段，再将制作镜头加入图片轨。');
    const shot = p.productionShots?.find(({ id }) => id === command.shotId);
    if (shot?.nodeId !== nodeId) throw new Error('制作镜头不存在或不属于此节点。');
    const assetId = command.frame === 'first' ? shot.firstFrameAssetId : shot.lastFrameAssetId;
    if (!assetId || !p.assets.some((asset) => asset.id === assetId && asset.type === 'image'))
      throw new Error('此帧没有可用的已入库图片。');
    resultId = uid('still');
    saveStills([...stills, { id: resultId, assetId, durationMs: shot.durationMs }]);
  } else if (command.action === 'add_stills') {
    if (timeline.videoClips.length) throw new Error('请先移除视频片段，再添加图片分镜。');
    const names = new Map(p.assets.map((asset) => [asset.id, asset.name]));
    const assetIds = [...command.assetIds];
    if (command.sortByName) {
      const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
      assetIds.sort((a, b) => collator.compare(names.get(a) ?? '', names.get(b) ?? ''));
    }
    const clips = assetIds.map((assetId) => ({
      id: uid('still'),
      assetId,
      durationMs: command.durationMs,
    }));
    resultId = clips[0].id;
    saveStills([...stills, ...clips]);
  } else if (command.action === 'align_stills_to_dialogue') {
    const end = Math.ceil(dialogueEndMs(s));
    if (!stills.length || !end) throw new Error('请添加图片分镜并将音频标为配音。');
    if (end < stills.length) throw new Error('配音时长不足以容纳所有分镜。');
    let accumulated = 0;
    let previousEnd = 0;
    saveStills(
      stills.map((clip, index) => {
        accumulated += clip.durationMs;
        const boundary = Math.min(
          end - (stills.length - index - 1),
          Math.max(previousEnd + 1, Math.round((accumulated / durationMs) * end)),
        );
        const aligned = { ...clip, durationMs: boundary - previousEnd };
        previousEnd = boundary;
        return aligned;
      }),
    );
  } else if (command.action === 'add') {
    if (command.track === 'video' && stills.length)
      throw new Error('请先移除静态画面，再添加视频片段。');
    const asset = p.assets.find((a) => a.id === command.assetId && a.type === command.track);
    if (!asset || asset.durationMs <= 0) throw new Error('请选择具有有效时长的对应类型素材。');
    resultId = uid('clip');
    const clip = {
      id: resultId,
      assetId: asset.id,
      trimStartMs: 0,
      trimEndMs: asset.durationMs,
      volume: command.track === 'audio' ? 0.5 : 1,
    };
    if (command.track === 'video') timeline.videoClips.push(clip);
    else
      timeline.audioClips.push({
        ...clip,
        role: command.role,
        startMs: 0,
        durationMs: asset.durationMs,
        loop: false,
      });
  } else {
    resultId = command.clipId;
    const video = timeline.videoClips.find((c) => c.id === command.clipId);
    const audio = timeline.audioClips.find((c) => c.id === command.clipId);
    const still = stills.find((c) => c.id === command.clipId);
    if (!video && !audio && !still) throw new Error('时间线片段不存在，请先读取真实 ID。');
    if (command.action === 'update_still') {
      if (!still) throw new Error('该片段不是图片分镜。');
      saveStills(stills.map((clip) => (clip === still ? { ...clip, ...command.patch } : clip)));
    } else if (command.action === 'update_video') {
      if (!video) throw new Error('该片段不是视频。');
      Object.assign(video, command.patch);
    } else if (command.action === 'update_audio') {
      if (!audio) throw new Error('该片段不是 BGM。');
      Object.assign(audio, command.patch);
    } else if (command.action === 'remove') {
      if (still) saveStills(stills.filter((c) => c !== still));
      timeline.videoClips = timeline.videoClips.filter((c) => c.id !== command.clipId);
      timeline.audioClips = timeline.audioClips.filter((c) => c.id !== command.clipId);
    } else if (command.action === 'split_video') {
      if (!video || command.sourceMs <= video.trimStartMs || command.sourceMs >= video.trimEndMs)
        throw new Error('分割点必须位于视频片段内部。');
      const index = timeline.videoClips.indexOf(video);
      const right = { ...video, id: uid('clip'), trimStartMs: command.sourceMs };
      video.trimEndMs = command.sourceMs;
      timeline.videoClips.splice(index + 1, 0, right);
      resultId = right.id;
    } else if (still) {
      if (command.index >= stills.length) throw new Error('分镜排序位置无效。');
      const clips = stills.filter((clip) => clip !== still);
      clips.splice(command.index, 0, still);
      saveStills(clips);
    } else {
      if (!video || command.index >= timeline.videoClips.length)
        throw new Error('视频排序位置无效。');
      timeline.videoClips = timeline.videoClips.filter((c) => c.id !== command.clipId);
      timeline.videoClips.splice(command.index, 0, video);
    }
  }
  const candidate = { ...s, timeline, durationMs };
  const issues = timelineIssues(p, candidate);
  if (
    timeline.videoClips.length > 500 ||
    timeline.audioClips.length > 100 ||
    (timeline.stillClips?.length ?? 0) > 500
  )
    issues.push('时间线片段数量超出限制。');
  if (issues.length) throw new Error(issues.join(' '));
  s.timeline = timeline;
  s.durationMs = durationMs;
  s.assetId =
    timeline.videoClips[0]?.assetId ?? timeline.stillClips?.[0]?.assetId ?? timeline.stillAssetId;
  s.trimStartMs = 0;
  s.trimEndMs = undefined;
  return resultId;
}
