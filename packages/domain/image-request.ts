import { z } from 'zod';

export const shotImagePromptMaxLength = 8000;
const promptSection = (limit: number, description: string) =>
  z.string().trim().min(1).max(limit).describe(description);

const framePromptSections = z.strictObject({
  framing: promptSection(800, '取景与构图：景别、视角、机位高度与方向、裁切、焦点及画面重心。'),
  space: promptSection(
    1400,
    '空间：时间地点、画内空间锚点、前中后景、相对距离及遮挡。特写只写入画区域。',
  ),
  subject: promptSection(
    2400,
    '主体与状态：逐个写入画人物或物件的画内位置、朝向、表情、视线、姿态、可见的手与持物、当前服装与道具状态。只写此刻能看见的事实。',
  ),
  lighting: promptSection(1000, '光线与质感：光源的方向、软硬、明暗分布和本帧重要材质。'),
  references: promptSection(
    1200,
    '参考用途：按实际绑定的参考图名称说明每张图用于身份、当前服装、空间、道具或构图中的哪一项。',
  ).optional(),
  exclusions: promptSection(
    800,
    '画面限制：排除本帧易误画的元素，标明线索遮挡或需留空给后期的文字区。',
  ).optional(),
});

export const framePromptInput = z.union([
  framePromptSections,
  z
    .string()
    .trim()
    .max(shotImagePromptMaxLength)
    .describe('沿用现有提示词、用户指定原文或清空时使用字符串。'),
]);

export function formatFramePrompt(prompt: z.infer<typeof framePromptInput>) {
  if (typeof prompt === 'string') return prompt;
  const sections = [
    ['取景与构图', prompt.framing],
    ['空间', prompt.space],
    ['主体与状态', prompt.subject],
    ['光线与质感', prompt.lighting],
    ['参考用途', prompt.references],
    ['画面限制', prompt.exclusions],
  ];
  return sections.flatMap(([label, body]) => (body ? [`【${label}】${body}`] : [])).join('\n');
}

export const imageAspects = {
  '16:9': [1920, 1080, '横屏'],
  '9:16': [1080, 1920, '竖屏'],
  '3:2': [1536, 1024, '横向'],
  '2:3': [1024, 1536, '竖向'],
  '4:3': [1536, 1152, '横向'],
  '3:4': [1152, 1536, '竖向'],
  '1:1': [1280, 1280, '方形'],
} as const;

export const imageAspectSchema = z
  .enum(['16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '1:1'])
  .describe('指定出图宽高比：16:9、9:16、3:2、2:3、4:3、3:4 或 1:1。');
export const imageReferenceIdSchema = z.array(z.string().min(1).max(160)).max(8);
export const imageReferencesSchema = z
  .array(
    z.object({
      assetId: z.string().min(1).max(160),
      name: z.string().min(1).max(120),
    }),
  )
  .max(8);
