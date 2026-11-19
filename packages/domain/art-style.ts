import { z } from 'zod';
import {
  creativeStyleGroups,
  creativeVisualStyleSchema,
  type CreativeDefaults,
} from './creative-options';

export const artStylePresets = {
  realistic: {
    label: '真人写实',
    prompt: '真人实拍质感，自然的人体比例、材质和光线，保留真实细节。',
  },
  anime: {
    label: '二次元动画',
    prompt: '二维动画美术，清晰线稿、有设计感的色块和一致的赛璐珞明暗。',
  },
  threeD: {
    label: '3D 动画',
    prompt: '风格统一的 3D 动画渲染，立体造型、明确的材质和柔和的空间光照。',
  },
  illustration: {
    label: '绘本插画',
    prompt: '手绘插画质感，保留笔触，造型和配色体现统一的美术方向。',
  },
  custom: { label: '自定义', prompt: '' },
} as const;

export const artStylePresetSchema = z.enum(['realistic', 'anime']);

export const artStyleSchema = z.object({
  preset: z.enum([...artStylePresetSchema.options, 'threeD', 'illustration', 'custom']),
  description: z.string().max(2000).optional(),
});
export const selectableArtStyleSchema = artStyleSchema.extend({ preset: artStylePresetSchema });
export type ArtStyle = z.infer<typeof artStyleSchema>;
export const productionArtStyleSchema = artStyleSchema.extend({
  reference: creativeVisualStyleSchema.optional(),
});
export type ProductionArtStyle = z.infer<typeof productionArtStyleSchema>;

export function resolveProjectArtStyle(settings: {
  artStyle?: ArtStyle;
  creativeDefaults?: CreativeDefaults;
}): ProductionArtStyle | undefined {
  const reference = settings.creativeDefaults?.visualStyle;
  if (!reference) return settings.artStyle;
  const preset = creativeStyleGroups['3D'].some((style) => style === reference)
    ? 'threeD'
    : creativeStyleGroups['2D'].some((style) => style === reference) ||
        reference === '二次元' ||
        reference === '国风水墨'
      ? 'anime'
      : 'realistic';
  return { preset, description: settings.artStyle?.description, reference };
}

export const atmosphereToneMaxLength = 2000;
export const atmosphereToneSchema = z.string().max(atmosphereToneMaxLength);

export function atmosphereDirection(tone?: string) {
  const description = tone?.trim();
  return description ? `\n\n风格补充描述\n${description}` : '';
}
