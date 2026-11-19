import { z } from 'zod';
import {
  productionArtStyleSchema,
  atmosphereToneSchema,
  type ProductionArtStyle,
} from './art-style';
import { shotAssetIds } from './production-shots';
import { imageAspectSchema, imageReferencesSchema } from './image-request';
import {
  uid,
  worldSettingFields,
  worldSettingSchema,
  type Asset,
  type Project,
  type WorldSetting,
} from './schema';

type SettingFields = Omit<WorldSetting, 'id' | 'kind'>;

export const worldReferenceKind = z.enum(['audio', 'image']);
export type WorldReferenceKind = z.infer<typeof worldReferenceKind>;
export const worldReferenceExtensions = {
  image: ['jpg', 'jpeg', 'png', 'webp'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'],
};
export const worldReferenceRequestSchema = z.object({
  kind: worldReferenceKind,
  settingKind: worldSettingSchema.shape.kind,
  name: worldSettingFields.shape.name,
  description: z.string().trim().min(1).max(2400),
  characterProfile: worldSettingFields.shape.description,
  imagePrompt: worldSettingFields.shape.imagePrompt,
  artStyle: productionArtStyleSchema.optional(),
  atmosphereTone: atmosphereToneSchema.optional(),
  imageAspect: imageAspectSchema.optional(),
  references: imageReferencesSchema.optional(),
});
export type WorldReferenceRequest = z.infer<typeof worldReferenceRequestSchema>;
export type WorldReferenceStatus = 'queued' | 'running';
export type GenerateWorldReference = (
  projectId: string,
  request: WorldReferenceRequest,
  signal: AbortSignal,
  onStatus?: (status: WorldReferenceStatus) => void,
  operationId?: string,
) => Promise<Asset>;

export function worldReferenceRequest(
  setting: WorldSetting,
  kind: WorldReferenceKind,
  artStyle?: ProductionArtStyle,
  atmosphereTone?: string,
): WorldReferenceRequest {
  const description = (kind === 'audio' ? setting.sound : setting.visual)?.trim();
  if (!description) throw new Error(kind === 'audio' ? '请先填写声音描述。' : '请先填写画面描述。');
  return worldReferenceRequestSchema.parse({
    kind,
    settingKind: setting.kind,
    name: setting.name,
    description,
    ...(kind === 'audio' && setting.kind === 'character' && setting.description
      ? { characterProfile: setting.description }
      : {}),
    ...(kind === 'image' && setting.imagePrompt ? { imagePrompt: setting.imagePrompt } : {}),
    ...(kind === 'image' && artStyle ? { artStyle } : {}),
    ...(kind === 'image' && atmosphereTone?.trim()
      ? { atmosphereTone: atmosphereTone.trim() }
      : {}),
  });
}

export function attachWorldReference(
  project: Project,
  settingId: string,
  kind: WorldReferenceKind,
  asset: Asset,
) {
  const previous = findWorldSetting(project, settingId);
  if (asset.type !== kind) throw new Error('生成的素材与参考类型不符。');
  if (!project.assets.some((entry) => entry.id === asset.id)) project.assets.push(asset);
  const setting = updateWorldSetting(
    project,
    settingId,
    kind === 'audio' ? { audioAssetId: asset.id } : { imageAssetId: asset.id },
  );
  if (kind === 'image') {
    const label = setting.kind === 'character' ? '定妆参考图' : '场景参考图';
    const used = new Set(project.worldSettings?.map((entry) => entry.imageAssetId));
    for (const shot of project.productionShots ?? [])
      for (const id of shotAssetIds(shot)) if (id) used.add(id);
    for (const scene of project.scenes) {
      used.add(scene.assetId);
      used.add(scene.timeline?.stillAssetId);
      for (const clip of scene.timeline?.stillClips ?? []) used.add(clip.assetId);
      for (const clip of scene.timeline?.videoClips ?? []) used.add(clip.assetId);
      for (const clip of scene.timeline?.audioClips ?? []) used.add(clip.assetId);
    }
    project.assets = project.assets.filter(
      (entry) =>
        !isGeneratedReferenceImage(entry) ||
        used.has(entry.id) ||
        (entry.id !== previous.imageAssetId && entry.name !== `${setting.name} · ${label}.png`),
    );
  }
  return setting;
}

export function isGeneratedReferenceImage(asset: Asset) {
  return (
    asset.type === 'image' &&
    !asset.builtin &&
    /^asset_[a-f0-9]{24}$/.test(asset.id) &&
    [`assets/${asset.id.slice(6)}.png`, `assets/reference/${asset.id.slice(6)}.png`].includes(
      asset.path,
    ) &&
    asset.thumbnail === asset.path &&
    / · (?:定妆参考图|场景参考图)\.png$/u.test(asset.name)
  );
}

export function findWorldSetting(project: Project, id: string) {
  const setting = project.worldSettings?.find((entry) => entry.id === id);
  if (!setting) throw new Error('找不到这条设定。');
  return setting;
}

export function matchesWorldSetting(setting: WorldSetting, query: string) {
  const term = query.trim().toLowerCase();
  return [
    setting.name,
    setting.description,
    setting.visual,
    setting.sound,
    setting.imagePrompt,
  ].some((text) => text?.toLowerCase().includes(term));
}

export function worldSettingIssue(project: Project, setting: WorldSetting) {
  const name = setting.name.toLowerCase();
  if (
    project.worldSettings?.some(
      (entry) =>
        entry.id !== setting.id && entry.kind === setting.kind && entry.name.toLowerCase() === name,
    )
  )
    return '已有同名设定，请更新原设定或改用其他名称。';
  if (
    setting.imageAssetId &&
    !project.assets.some((asset) => asset.id === setting.imageAssetId && asset.type === 'image')
  )
    return '设定引用的图片素材不存在或类型错误。';
  if (
    setting.audioAssetId &&
    !project.assets.some((asset) => asset.id === setting.audioAssetId && asset.type === 'audio')
  )
    return '设定引用的音频素材不存在或类型错误。';
}

function putWorldSetting(project: Project, input: WorldSetting) {
  const setting = worldSettingSchema.parse(input);
  const issue = worldSettingIssue(project, setting);
  if (issue) throw new Error(issue);
  const entries = project.worldSettings ?? [];
  const index = entries.findIndex((entry) => entry.id === setting.id);
  if (index >= 0) entries[index] = setting;
  else {
    if (entries.length >= 500) throw new Error('每个工程最多可维护 500 条设定。');
    entries.push(setting);
  }
  project.worldSettings = entries;
  return setting;
}

export function createWorldSetting(
  project: Project,
  kind: WorldSetting['kind'],
  fields: SettingFields,
) {
  return putWorldSetting(project, { ...fields, id: uid('setting'), kind });
}

export function updateWorldSetting(project: Project, id: string, patch: Partial<SettingFields>) {
  return putWorldSetting(project, { ...findWorldSetting(project, id), ...patch });
}

export function linkWorldSetting(project: Project, id: string, nodeIds: string[], linked: boolean) {
  findWorldSetting(project, id);
  const nodes = [...new Set(nodeIds)].map((nodeId) => {
    const node = project.scenes.find((scene) => scene.id === nodeId);
    if (!node) throw new Error('找不到要关联的剧情节点。');
    if (linked && (node.settingIds?.length ?? 0) >= 100 && !node.settingIds?.includes(id))
      throw new Error('每个节点最多可关联 100 条设定。');
    return node;
  });
  for (const node of nodes) {
    const current = node.settingIds ?? [];
    const next = linked ? [...new Set([...current, id])] : current.filter((value) => value !== id);
    if (next.length !== current.length) node.settingIds = next.length ? next : undefined;
  }
}

export function deleteWorldSetting(project: Project, id: string) {
  const setting = findWorldSetting(project, id);
  const linked = project.scenes.filter((scene) => scene.settingIds?.includes(id));
  linkWorldSetting(
    project,
    id,
    linked.map((scene) => scene.id),
    false,
  );
  for (const shot of project.productionShots ?? []) {
    if (shot.settingIds?.includes(id))
      shot.settingIds = shot.settingIds.filter((value) => value !== id);
  }
  project.worldSettings = project.worldSettings?.filter((entry) => entry.id !== id);
  return setting;
}
