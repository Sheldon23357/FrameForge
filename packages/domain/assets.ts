import type { Asset, Project } from './schema';
import { shotAssetIds } from './production-shots';

export const audioAssetCategories = ['music', 'voice', 'sound'] as const;
export type AudioAssetCategory = (typeof audioAssetCategories)[number];
export const assetCategories = ['video', 'image', ...audioAssetCategories, 'reference'] as const;
export type AssetCategory = (typeof assetCategories)[number];

export function importedAssetId(hash: string, category: AssetCategory) {
  return category === 'video' || category === 'image'
    ? `asset_${hash}`
    : `asset_${category}_${hash}`;
}

export function assetCategory(
  asset: Pick<Asset, 'type' | 'name' | 'path'>,
  hints?: { reference?: boolean; voice?: boolean; sound?: boolean; music?: boolean },
): AssetCategory {
  if (asset.type === 'video') return 'video';
  if (asset.type === 'image')
    return hints?.reference ||
      asset.path.startsWith('assets/reference/') ||
      /(?:定妆参考图|场景参考图|设定(?:参考)?图)\.[^.]+$/u.test(asset.name)
      ? 'reference'
      : 'image';
  const directory = audioAssetCategories.find((kind) => asset.path.startsWith(`assets/${kind}/`));
  if (directory) return directory;
  if (
    hints?.voice ||
    /干声|语音|对白|旁白|配音|台词|dialogue|voice|narration|tts/i.test(asset.name)
  )
    return 'voice';
  if (hints?.music) return 'music';
  if (hints?.sound || /环境声|音效|雨声|风声|ambient|ambience|sfx/i.test(asset.name))
    return 'sound';
  return 'music';
}

export function assetInUse(project: Project, assetId: string): boolean {
  return (
    project.scenes.some(
      ({ assetId: sceneAssetId, timeline }) =>
        sceneAssetId === assetId ||
        timeline?.stillAssetId === assetId ||
        timeline?.stillClips?.some((clip) => clip.assetId === assetId) ||
        timeline?.videoClips.some((clip) => clip.assetId === assetId) ||
        timeline?.audioClips.some((clip) => clip.assetId === assetId),
    ) ||
    (project.worldSettings ?? []).some(
      (setting) => setting.imageAssetId === assetId || setting.audioAssetId === assetId,
    ) ||
    (project.productionShots ?? []).some((shot) => shotAssetIds(shot).includes(assetId))
  );
}

export function removeAsset(project: Project, assetId: string): Asset {
  const index = project.assets.findIndex((asset) => asset.id === assetId);
  if (index < 0) throw new Error('找不到素材。');
  if (assetInUse(project, assetId))
    throw new Error('此素材仍被节点、时间线、设定或制作镜头引用，请先移除或替换引用。');
  const [asset] = project.assets.splice(index, 1);
  return asset;
}

export function filterAssets(
  project: Project,
  filters: { category?: AssetCategory | 'audio'; type?: Asset['type']; query?: string },
) {
  const { category, type } = filters;
  const query = filters.query?.toLowerCase() ?? '';
  const referenceIds = new Set(project.worldSettings?.map((setting) => setting.imageAssetId));
  const voiceIds = new Set<string>();
  const soundIds = new Set<string>();
  const musicIds = new Set<string>();
  if (category && category !== 'audio') {
    for (const setting of project.worldSettings ?? []) {
      if (setting.audioAssetId)
        (setting.kind === 'character' ? voiceIds : soundIds).add(setting.audioAssetId);
    }
    for (const scene of project.scenes)
      for (const clip of scene.timeline?.audioClips ?? []) {
        if (clip.role === 'dialogue') voiceIds.add(clip.assetId);
        if (clip.role === 'effect') soundIds.add(clip.assetId);
        if (clip.role === 'music') musicIds.add(clip.assetId);
      }
  }

  return project.assets.filter((asset) => {
    if (type && asset.type !== type) return false;
    if (query && !asset.name.toLowerCase().includes(query)) return false;
    if (!category) return true;

    if (category === 'audio') return asset.type === 'audio';
    return (
      category ===
      assetCategory(asset, {
        reference: referenceIds.has(asset.id),
        voice: voiceIds.has(asset.id),
        sound: soundIds.has(asset.id),
        music: musicIds.has(asset.id),
      })
    );
  });
}
