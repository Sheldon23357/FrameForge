import { z } from 'zod';
import { runMediaJob } from '../media-jobs';
import { audioAssetCategories } from '../../domain/assets';
import { resolveProjectArtStyle } from '../../domain/art-style';
import { productionAudioRequestSchema } from '../../domain/production-audio';
import { shotImageRequestSchema } from '../../domain/production-shots';
import {
  formatFramePrompt,
  framePromptInput,
  imageAspectSchema,
  imageReferenceIdSchema,
} from '../../domain/image-request';
import type { Asset, ProductionShot, Project } from '../../domain/schema';
import type { ToolResult } from '../types';
import {
  attachWorldReference,
  findWorldSetting,
  worldReferenceKind,
  worldReferenceRequest,
} from '../../domain/world-settings';
import type { ToolRegistry } from './registry';

const imageOptions = {
  imageAspect: imageAspectSchema.optional(),
  referenceAssetIds: imageReferenceIdSchema
    .optional()
    .describe('额外的已有图片素材 ID，按附图顺序排列。'),
};
const shotArgs = z.strictObject({
  shotId: z.string().min(1).max(160),
  frame: shotImageRequestSchema.shape.frame.default('first'),
  prompt: framePromptInput
    .describe(
      '省略时采用镜头卡对应帧的已存提示词。结构对象作为完整的本次静帧提示词，字符串用于追加用户指定的额外要求。',
    )
    .optional(),
  settingIds: imageReferenceIdSchema.optional(),
  ...imageOptions,
  replace: z.boolean().default(false).describe('用户明确要求替换现有帧时设为 true。'),
  newJob: z.boolean().default(false).describe('明确要求重新生成或重试失败作业时设为 true。'),
});
const settingArgs = z.strictObject({
  settingId: z.string().min(1).max(160),
  kind: worldReferenceKind,
  ...imageOptions,
  replace: z.boolean().default(false),
  newJob: z.boolean().default(false).describe('仅用户明确要求重新生成或重试时设为 true。'),
});
export const imageBatchTool = 'generate_image_batch';
const batchArgs = z.strictObject({
  jobs: z
    .array(
      z.discriminatedUnion('target', [
        shotArgs.extend({ target: z.literal('shot') }),
        settingArgs.omit({ kind: true }).extend({ target: z.literal('setting') }),
      ]),
    )
    .min(2)
    .max(8),
});
type ImageJob = z.infer<typeof batchArgs>['jobs'][number];

export function imageJobCall({ target, ...job }: ImageJob) {
  return target === 'shot'
    ? { name: 'generate_shot_image', args: job }
    : { name: 'generate_world_reference', args: { ...job, kind: 'image' } };
}

function addImageReferences(
  project: Project,
  ids: string[] = [],
  references: { assetId: string; name: string }[] = [],
) {
  for (const id of new Set(ids)) {
    if (references.some(({ assetId }) => assetId === id)) continue;
    const asset = project.assets.find((asset) => asset.id === id && asset.type === 'image');
    if (!asset) throw new Error(`找不到图片参考素材 ${id}。`);
    references.push({ assetId: id, name: asset.name.slice(0, 120) });
  }
  if (references.length > 8) throw new Error('每张图最多使用 8 张参考图。');
  return references;
}

function attachShotImage(
  project: Project,
  shot: ProductionShot,
  frame: 'first' | 'last',
  asset: Asset,
) {
  if (asset.type !== 'image') throw new Error('分镜生成未返回有效图片。');
  if (!project.assets.some(({ id }) => id === asset.id)) project.assets.push(asset);
  shot[frame === 'last' ? 'lastFrameAssetId' : 'firstFrameAssetId'] = asset.id;
}

export function registerMediaTools(registry: ToolRegistry) {
  registry.register({
    name: 'generate_production_audio',
    label: '用 Codex CLI 制作 BGM',
    group: 'story',
    category: 'timeline',
    mode: 'write',
    description:
      '用桌面版配置的 Codex CLI 编排并本地合成器乐 BGM WAV，category 固定为 music。单段 100–30000 毫秒。返回可用于 edit_timeline 的真实素材 ID 与时长。用户允许复用时先用 read_project.assets 搜索 music 分类。',
    schema: productionAudioRequestSchema.extend({
      newJob: z.boolean().default(false).describe('明确要求重试失败作业或重新制作时设为 true。'),
    }),
    async executeAsync(context, { newJob, ...request }) {
      const { project, media, signal } = context;
      const generate = media?.generateProductionAudio;
      if (!generate || !signal) throw new Error('请在桌面版使用 Codex CLI 制作 BGM。');
      signal.throwIfAborted();
      const [asset] = await runMediaJob(
        context,
        'audio',
        JSON.stringify(['production-audio', request]),
        newJob,
        async (id) => [await generate(project.id, request, signal, id)],
      );
      signal.throwIfAborted();
      if (asset?.type !== 'audio' || asset.durationMs <= 0)
        throw new Error('Codex CLI 未返回可用的音频素材。');
      if (!project.assets.some(({ id }) => id === asset.id)) project.assets.push(asset);
      const { id: assetId, name, durationMs } = asset;
      return { ok: true, summary: `已制作「${name}」`, data: { assetId, name, durationMs } };
    },
  });
  registry.register({
    name: 'generate_shot_image',
    label: '生成并绑定分镜图',
    group: 'story',
    category: 'timeline',
    mode: 'write',
    description:
      '生成一张静态分镜图并绑定镜头卡。使用真实 shotId，默认首帧，尾帧用 frame=last。用 frameforge-storyboard-prompts 编写结构化静帧提示词，优先用 edit_production_shot 保存后出图。保存后省略 prompt；临时完整改稿可用 prompt 对象。机位、动作与声音字段不会代替帧提示词。默认沿用作品比例与画风，imageAspect 可指定比例。设定图先用本次 settingIds，其次镜头卡的 settingIds，再用节点关联设定。referenceAssetIds 可追加本帧实际使用的参考。MiniMax 多张独立图片用 generate_image_batch。',
    schema: shotArgs,
    async executeAsync(
      context,
      { shotId, frame, prompt, settingIds, imageAspect, referenceAssetIds, replace, newJob },
    ) {
      const { project, media, signal } = context;
      if (!media?.generateShotImage || !signal) throw new Error('请在桌面版生成分镜图。');
      const shot = project.productionShots?.find(({ id }) => id === shotId);
      const node = project.scenes.find(({ id }) => id === shot?.nodeId);
      if (!shot || node?.kind !== 'video') throw new Error('找不到此视频节点的制作镜头卡。');
      const first = frame === 'first';
      const slot = first ? 'firstFrameAssetId' : 'lastFrameAssetId';
      const frameLabel = first ? '首帧' : '尾帧';
      if (shot[slot] && !replace)
        throw new Error(`镜头已绑定${frameLabel}，替换时请传 replace=true。`);
      signal.throwIfAborted();
      const savedPrompt = first ? shot.firstFramePrompt : shot.lastFramePrompt;
      const framePrompt =
        typeof prompt === 'object'
          ? formatFramePrompt(prompt)
          : [prompt, savedPrompt].filter(Boolean).join('\n');
      if (!framePrompt)
        throw new Error(
          `请先用 edit_production_shot 保存${frameLabel}的结构化画面提示词，或为本次生成提供 prompt 对象。`,
        );
      const relevantIds = [...new Set(settingIds ?? shot.settingIds ?? node.settingIds ?? [])];
      if (relevantIds.length > 8)
        throw new Error('请用 settingIds 指定本镜头实际入镜的设定，最多 8 项。');
      const references = relevantIds.map((id) => {
        const setting = findWorldSetting(project, id);
        const assetId = setting.imageAssetId;
        if (
          !assetId ||
          !project.assets.some((asset) => asset.id === assetId && asset.type === 'image')
        )
          throw new Error(
            `「${setting.name}」缺少设定图。请先补齐画面描述并调用 generate_world_reference。`,
          );
        return { assetId, name: setting.name };
      });
      const request = shotImageRequestSchema.parse({
        name: `${node.title} · ${shot.label}`.slice(0, 280),
        prompt: framePrompt,
        frame,
        aspect: project.settings.width < project.settings.height ? 'portrait' : 'landscape',
        artStyle: resolveProjectArtStyle(project.settings),
        atmosphereTone: project.settings.atmosphereTone?.trim() || undefined,
        imageAspect,
        references: addImageReferences(project, referenceAssetIds, references),
      });
      const [asset] = await runMediaJob(
        context,
        'image',
        JSON.stringify([
          media.imageProvider === 'minimax' ? 'minimax-shot-image' : 'shot-image',
          shotId,
          request,
        ]),
        newJob,
        async (id) => [await media.generateShotImage!(project.id, request, signal, id)],
      );
      signal.throwIfAborted();
      if (!asset) throw new Error('分镜生成未返回有效图片。');
      attachShotImage(project, shot, frame, asset);
      return {
        ok: true,
        summary: `已生成分镜${frameLabel}并绑定到镜头「${shot.label}」`,
        data: { shotId, frame, assetId: asset.id, name: asset.name },
        nodeIds: [node.id],
      };
    },
  });
  registry.register({
    name: 'generate_world_reference',
    label: '生成并绑定设定素材',
    group: 'story',
    category: 'world',
    mode: 'write',
    description:
      '桌面版使用已有设定生成参考图、角色干声或场景环境声，并绑定到该设定。设定图默认横向 3:2，沿用作品画风，可传 imageAspect 指定比例、referenceAssetIds 附加已有参考图。已有素材时，仅在用户要求替换时传 replace=true。MiniMax 多张独立图片用 generate_image_batch。',
    schema: settingArgs,
    async executeAsync(
      context,
      { settingId, kind, imageAspect, referenceAssetIds, replace, newJob },
    ) {
      const { project, media, signal } = context;
      if (!media?.generateReference || !signal) throw new Error('当前宿主不支持生成设定参考素材。');
      const setting = findWorldSetting(project, settingId);
      const slot = kind === 'image' ? 'imageAssetId' : 'audioAssetId';
      if (setting[slot] && !replace)
        throw new Error('设定已绑定参考素材，替换时请传 replace=true。');
      signal.throwIfAborted();
      const request = worldReferenceRequest(
        setting,
        kind,
        resolveProjectArtStyle(project.settings),
        project.settings.atmosphereTone,
      );
      if (kind === 'image') {
        if (imageAspect) request.imageAspect = imageAspect;
        if (referenceAssetIds?.length)
          request.references = addImageReferences(project, referenceAssetIds);
      }
      const [asset] = await runMediaJob(
        context,
        kind === 'image' ? 'image' : 'audio',
        JSON.stringify([
          kind === 'image' && media.imageProvider === 'minimax' ? 'minimax-reference' : 'generate',
          settingId,
          request,
        ]),
        newJob,
        async (id) => [await media.generateReference!(project.id, request, signal, undefined, id)],
      );
      signal.throwIfAborted();
      attachWorldReference(project, settingId, kind, asset);
      return {
        ok: true,
        summary: '已生成设定参考素材并绑定到本轮草稿',
        data: { settingId, assetId: asset.id },
      };
    },
  });
  registry.register({
    name: imageBatchTool,
    label: '批量生成设定图与分镜图',
    group: 'story',
    category: 'world',
    mode: 'write',
    description:
      'MiniMax 图像服务可一次提交 2–8 张独立图片。jobs 每项用 target=setting 与 settingId，或 target=shot 与 shotId；分镜与单张工具共用静帧提示词、比例、参考图和替换规则。每个目标帧只出现一次。需要本批生成的新设定图作为参考的分镜，放到下一批。逐项报告成功或失败，并绑定成功项。',
    schema: batchArgs,
    async executeAsync(context, { jobs }) {
      if (context.media?.imageProvider !== 'minimax')
        throw new Error('在设置中选择 MiniMax 图像服务后可使用并发生图。');
      const project = context.project;
      const targets = new Set<string>();
      const mediaJobs = (context.mediaJobs ??= []);
      const results = await Promise.all(
        jobs.map(async (job) => {
          const target =
            job.target === 'shot' ? `shot:${job.shotId}:${job.frame}` : `setting:${job.settingId}`;
          if (targets.has(target))
            return {
              ok: false,
              summary: '同一批次已有相同的生成目标。',
              asset: undefined,
            } satisfies ToolResult & { asset?: Asset };
          targets.add(target);
          const { name, args } = imageJobCall(job);
          const candidate = { ...context, mediaJobs };
          const result = await registry.executeAsync(name, JSON.stringify(args), candidate);
          const asset = result.ok
            ? candidate.project.assets.find(
                ({ id }) => id === (result.data as { assetId: string }).assetId,
              )
            : undefined;
          return { ...result, asset };
        }),
      );
      context.signal?.throwIfAborted();
      const nodeIds = new Set<string>();
      const items = results.map(({ asset, ...result }, index) => {
        const job = jobs[index];
        if (result.ok) {
          if (!asset) throw new Error('生成图片的素材记录已丢失。');
          if (job.target === 'setting')
            attachWorldReference(project, job.settingId, 'image', asset);
          else {
            const shot = project.productionShots!.find(({ id }) => id === job.shotId)!;
            attachShotImage(project, shot, job.frame, asset);
          }
          for (const id of result.nodeIds ?? []) nodeIds.add(id);
        }
        return {
          index,
          ...(job.target === 'shot'
            ? { target: job.target, shotId: job.shotId, frame: job.frame }
            : { target: job.target, settingId: job.settingId }),
          ...result,
        };
      });
      const succeeded = items.filter(({ ok }) => ok).length;
      return {
        ok: succeeded > 0,
        summary: `已生成并绑定 ${succeeded}/${jobs.length} 张图片${succeeded ? '' : '，请查看各项错误'}`,
        data: { items },
        nodeIds: [...nodeIds],
      };
    },
  });
  registry.register({
    name: 'import_assets',
    label: '选择并导入素材',
    group: 'project',
    mode: 'write',
    description:
      '用户明确要求导入时打开桌面文件选择器。可用 audioCategory 将本次导入限制为音乐、语音或音效。返回可用于镜头卡或时间线的素材 ID。用户取消后本次导入结束。',
    schema: z.strictObject({
      audioCategory: z.enum(audioAssetCategories).optional(),
      newJob: z.boolean().default(false).describe('用户明确要求再次选择文件时才设为 true。'),
    }),
    async executeAsync(context, { audioCategory, newJob }) {
      const { project, media, signal } = context;
      if (!media?.importAssets || !signal) throw new Error('当前宿主不支持桌面素材导入。');
      signal.throwIfAborted();
      const assets = await runMediaJob(
        context,
        'import',
        JSON.stringify(['import', audioCategory]),
        newJob,
        (id) => media.importAssets!(audioCategory, id),
      );
      signal.throwIfAborted();
      if (!assets.length)
        return { ok: true, summary: '用户取消了素材导入', data: { cancelled: true, assets: [] } };
      const byId = new Map(project.assets.map((asset) => [asset.id, asset]));
      for (const asset of assets) byId.set(asset.id, asset);
      project.assets = [...byId.values()];
      return {
        ok: true,
        summary: `已将 ${assets.length} 项素材导入本轮草稿`,
        data: { assets: assets.map(({ id, name, type }) => ({ id, name, type })) },
      };
    },
  });
}
