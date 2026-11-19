import { z } from 'zod';
import { productionArtStyleSchema, atmosphereToneSchema } from './art-style';
import {
  imageAspectSchema,
  imageReferencesSchema,
  shotImagePromptMaxLength,
} from './image-request';
import type { Asset, ProductionShot, Project } from './schema';

export const shotImageRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(280),
  prompt: z.string().trim().min(1).max(shotImagePromptMaxLength),
  frame: z.enum(['first', 'last']),
  aspect: z.enum(['landscape', 'portrait']),
  imageAspect: imageAspectSchema.optional(),
  references: imageReferencesSchema.default([]),
  artStyle: productionArtStyleSchema.optional(),
  atmosphereTone: atmosphereToneSchema.optional(),
});
export type ShotImageRequest = z.infer<typeof shotImageRequestSchema>;
export type GenerateShotImage = (
  projectId: string,
  shotImage: ShotImageRequest,
  signal: AbortSignal,
  operationId: string,
) => Promise<Asset>;

export const shotAssetFields = {
  firstFrameAssetId: 'image',
  lastFrameAssetId: 'image',
  videoAssetId: 'video',
} as const;
const assetFields = Object.keys(shotAssetFields) as (keyof typeof shotAssetFields)[];

export function shotAssetIds(shot: ProductionShot) {
  return assetFields.map((field) => shot[field]);
}

export function productionShotFrames(
  shots: Project['productionShots'],
  assets: readonly Asset[],
  nodeId: string,
) {
  return (shots ?? []).flatMap((shot) => {
    if (shot.nodeId !== nodeId) return [];
    return (['firstFrameAssetId', 'lastFrameAssetId'] as const).flatMap((field) => {
      const id = shot[field];
      const asset = id && assets.find((item) => item.id === id && item.type === 'image');
      return asset
        ? [
            {
              key: `${shot.id}:${field}`,
              shotId: shot.id,
              frame: field === 'firstFrameAssetId' ? ('first' as const) : ('last' as const),
              label: `${shot.label} · ${field === 'firstFrameAssetId' ? '首帧' : '尾帧'}`,
              asset,
            },
          ]
        : [];
    });
  });
}

export function productionShotIssue(
  shot: ProductionShot,
  nodes: ReadonlyMap<string, { kind: string }>,
  assets: ReadonlyMap<string, Asset>,
  settings: ReadonlySet<string>,
): string | undefined {
  if (nodes.get(shot.nodeId)?.kind !== 'video') return '须关联有效的视频剧情节点。';
  if (shot.settingIds?.some((id) => !settings.has(id))) return '镜头引用了不存在的设定。';
  for (const field of assetFields) {
    const id = shot[field];
    if (id && assets.get(id)?.type !== shotAssetFields[field])
      return `引用素材不存在或类型不匹配（${field}）。`;
  }
}

export function removeProductionShots(project: Project, nodeIds: readonly string[]) {
  if (!project.productionShots?.some((shot) => nodeIds.includes(shot.nodeId))) return;
  project.productionShots = project.productionShots.filter(
    (shot) => !nodeIds.includes(shot.nodeId),
  );
  if (!project.productionShots.length) delete project.productionShots;
}
