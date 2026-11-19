import { z } from 'zod';
import { migrateProject } from './migrations';
import { artStyleSchema, atmosphereToneSchema } from './art-style';
import { creativeDefaultsSchema } from './creative-options';
import { imageReferenceIdSchema, shotImagePromptMaxLength } from './image-request';
import { storyDesignSchema } from './story-design';
import { screenplayEntry } from './screenplay';

export type Value = number | string | boolean;
export type Condition =
  | { kind: 'all' | 'any'; children: Condition[] }
  | { kind: 'not'; child: Condition }
  | {
      kind: 'variable';
      variableId: string;
      op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
      value: Value;
    }
  | { kind: 'item'; itemId: string; op: 'gte' | 'eq' | 'lt'; count: number }
  | { kind: 'visited'; nodeId: string };
const valueSchema = z.union([z.number().finite(), z.string(), z.boolean()]);
const id = z
  .string()
  .min(1)
  .max(160)
  .refine((v) => !['__proto__', 'constructor', 'prototype'].includes(v), '保留的 ID 不可使用');
export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ kind: z.enum(['all', 'any']), children: z.array(conditionSchema).max(100) }),
    z.object({ kind: z.literal('not'), child: conditionSchema }),
    z.object({
      kind: z.literal('variable'),
      variableId: id,
      op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']),
      value: valueSchema,
    }),
    z.object({
      kind: z.literal('item'),
      itemId: id,
      op: z.enum(['gte', 'eq', 'lt']),
      count: z.number().int().nonnegative(),
    }),
    z.object({ kind: z.literal('visited'), nodeId: id }),
  ]),
);
export const effectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('setVariable'), variableId: id, value: valueSchema }),
  z.object({ kind: z.literal('addVariable'), variableId: id, value: z.number().finite() }),
  z.object({ kind: z.literal('addItem'), itemId: id, count: z.number().int().positive() }),
  z.object({ kind: z.literal('removeItem'), itemId: id, count: z.number().int().positive() }),
  z.object({
    kind: z.literal('showMessage'),
    title: z.string().max(100).default('剧情提示'),
    text: z.string().max(2000).describe('玩家确认后继续播放的剧情反馈正文，不能为空。'),
  }),
]);
export type Effect = z.infer<typeof effectSchema>;
export const choiceSchema = z.object({
  id,
  label: z.string().max(500),
  targetId: z.string(),
  condition: conditionSchema,
  lockedText: z.string().default('尚未满足条件'),
  hiddenWhenLocked: z.boolean().default(false),
});
export type Choice = z.infer<typeof choiceSchema>;
export const eventSchema = z.object({
  id,
  name: z.string(),
  trigger: z.enum(['enter', 'time', 'exit', 'complete']),
  atMs: z.number().nonnegative(),
  once: z.boolean(),
  effects: z.array(effectSchema),
});
export type StoryEvent = z.infer<typeof eventSchema>;
export const videoClipSchema = z.object({
  id,
  assetId: id,
  trimStartMs: z.number().finite().nonnegative(),
  trimEndMs: z.number().finite().positive(),
  volume: z.number().min(0).max(1).default(1),
});
export const audioClipSchema = videoClipSchema.extend({
  role: z.enum(['dialogue', 'music', 'effect']).optional(),
  startMs: z.number().finite().nonnegative(),
  durationMs: z.number().finite().positive(),
  loop: z.boolean().default(false),
  fadeInMs: z.number().finite().nonnegative().optional(),
  fadeOutMs: z.number().finite().nonnegative().optional(),
});
export const stillClipSchema = z.object({
  id,
  assetId: id,
  durationMs: z.number().finite().positive(),
  dissolveMs: z.number().finite().min(0).max(500).optional(),
});
export const timelineSchema = z.object({
  stillAssetId: id.optional(),
  stillClips: z.array(stillClipSchema).max(500).optional(),
  videoClips: z.array(videoClipSchema).max(500),
  audioClips: z.array(audioClipSchema).max(100),
});
export type VideoClip = z.infer<typeof videoClipSchema>;
export type AudioClip = z.infer<typeof audioClipSchema>;
export type StillClip = z.infer<typeof stillClipSchema>;
export type Timeline = z.infer<typeof timelineSchema>;
export const defaultStoryboardPageDurationMs = 3000;
export const choiceQuestionMaxLength = 20;
export const storyboardPagesSchema = z
  .array(
    z.object({
      text: z.string().trim().min(1).max(160).describe('显示给玩家的剧情文字，每页最多 160 字。'),
      durationMs: z.number().int().min(1000).max(60000).default(defaultStoryboardPageDurationMs),
    }),
  )
  .max(20)
  .describe(
    `按播放顺序排列的故事板。每页停留时长以毫秒计，默认 ${defaultStoryboardPageDurationMs}。`,
  );
export const sceneSchema = z.object({
  id,
  kind: z.enum(['video', 'branch', 'ending']),
  title: z.string().max(200),
  chapterId: id,
  notes: z.string().max(10000).default(''),
  storyboardPages: storyboardPagesSchema.optional(),
  storyboardScreenplayVersion: z.uuid().optional(),
  storyboardOverlay: z.boolean().optional().describe('在图片或视频画面上叠加故事板文字。'),
  settingIds: z.array(id).max(100).optional(),
  assetId: z.string().optional(),
  timeline: timelineSchema.optional(),
  durationMs: z.number().positive().default(8000),
  trimStartMs: z.number().nonnegative().default(0),
  trimEndMs: z.number().positive().optional(),
  choiceQuestion: z.string().max(choiceQuestionMaxLength).optional(),
  choicesAtMs: z.number().nonnegative().nullable().default(null),
  choiceMode: z.enum(['pause', 'continue']).default('pause'),
  nextId: z.string().default(''),
  choices: z.array(choiceSchema),
  events: z.array(eventSchema),
  endingLabel: z.string().default('故事未完，选择由你。'),
  endingText: z.string().max(10000).default(''),
});
export type Scene = z.infer<typeof sceneSchema>;
export const variableSchema = z.object({
  id,
  name: z.string().min(1),
  type: z.enum(['number', 'boolean', 'string']),
  initial: valueSchema,
  hidden: z
    .boolean()
    .optional()
    .describe('是否隐藏属性；未设置视为 false。隐藏时不在玩家属性面板显示，仍参与剧情计算。'),
  min: z.number().optional(),
  max: z.number().optional(),
});
export type Variable = z.infer<typeof variableSchema>;
export const itemSchema = z.object({
  id,
  name: z.string().min(1),
  description: z.string(),
  initial: z.number().int().nonnegative(),
});
export type Item = z.infer<typeof itemSchema>;
export const assetSchema = z.object({
  id,
  name: z.string(),
  path: z.string(),
  type: z.enum(['video', 'image', 'audio']),
  size: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  thumbnail: z.string().optional(),
  builtin: z.boolean().default(false),
});
export type Asset = z.infer<typeof assetSchema>;
export const chapterSchema = z.object({
  id,
  title: z.string().trim().min(1).max(200),
  startNodeId: z.string().default(''),
});
export type Chapter = z.infer<typeof chapterSchema>;
export const worldSettingFields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2400).optional(),
  visual: z.string().trim().max(2400).optional(),
  imagePrompt: z.string().trim().max(2400).optional(),
  sound: z.string().trim().max(2400).optional(),
  imageAssetId: id.nullable().optional(),
  audioAssetId: id.nullable().optional(),
});
export const worldSettingSchema = worldSettingFields.extend({
  id,
  kind: z.enum(['character', 'location']),
});
export type WorldSetting = z.infer<typeof worldSettingSchema>;
const shotText = z.string().trim().max(2000);
const shotImagePrompt = z.string().trim().max(shotImagePromptMaxLength);
export const productionShotFields = z.object({
  label: z.string().trim().min(1).max(80),
  durationMs: z.number().int().positive().max(600_000),
  source: shotText.optional(),
  purpose: shotText.optional(),
  camera: shotText.optional(),
  startState: shotText.optional(),
  endState: shotText.optional(),
  action: shotText.optional(),
  audio: shotText.optional(),
  firstFramePrompt: shotImagePrompt.optional(),
  lastFramePrompt: shotImagePrompt.optional(),
  videoPrompt: z.string().trim().max(6000).optional(),
  videoModel: z.string().trim().max(120).optional(),
  settingIds: imageReferenceIdSchema.optional(),
  firstFrameAssetId: id.nullable().optional(),
  lastFrameAssetId: id.nullable().optional(),
  videoAssetId: id.nullable().optional(),
});
export const productionShotSchema = productionShotFields.extend({
  id,
  nodeId: id,
  screenplayVersion: z.uuid().optional(),
});
export type ProductionShot = z.infer<typeof productionShotSchema>;
export const projectSchema = z.object({
  formatVersion: z.literal(4),
  id,
  title: z.string().min(1).max(200),
  description: z.string(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string(),
  startNodeId: z.string(),
  settings: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    author: z.string(),
    artStyle: artStyleSchema.optional(),
    atmosphereTone: atmosphereToneSchema.optional(),
    creativeDefaults: creativeDefaultsSchema.optional(),
  }),
  scenes: z.array(sceneSchema).max(10000),
  chapters: z.array(chapterSchema).min(1).max(10000),
  variables: z.array(variableSchema),
  items: z.array(itemSchema),
  assets: z.array(assetSchema),
  worldSettings: z.array(worldSettingSchema).max(500).optional(),
  productionShots: z.array(productionShotSchema).max(10000).optional(),
  storyDesign: storyDesignSchema.optional(),
  screenplays: z.array(screenplayEntry).max(10000).optional(),
  layout: z.record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite() })),
  saveMigration: z
    .object({
      targetFingerprint: z.string().regex(/^[0-9a-f]{1,8}$/),
      fingerprints: z
        .array(z.string().regex(/^[0-9a-f]{1,8}$/))
        .min(1)
        .max(8),
      addVariables: z
        .array(
          z.object({
            id,
            sources: z
              .array(z.object({ itemId: id, value: z.number().nonnegative().finite() }))
              .max(100),
          }),
        )
        .max(20),
    })
    .optional(),
});
export type Project = z.infer<typeof projectSchema>;
export const legacySceneSchema = sceneSchema.extend({
  choices: z.array(choiceSchema.extend({ effects: z.array(effectSchema).optional() })),
});
export const legacyProjectSchema = projectSchema.extend({
  scenes: z.array(legacySceneSchema).max(10000),
});
type LegacyProject = z.infer<typeof legacyProjectSchema>;
export const storyStartId = (p: Pick<Project, 'chapters'>): string =>
  p.chapters[0]?.startNodeId ?? '';
export const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
export const always = (): Condition => ({ kind: 'all', children: [] });
export function makeChoice(label = '新的选择'): Choice {
  return {
    id: uid('choice'),
    label,
    targetId: '',
    condition: always(),
    lockedText: '尚未满足条件',
    hiddenWhenLocked: false,
  };
}
export function makeScene(
  kind: Scene['kind'],
  index: number,
  chapterId = 'chapter_default',
): Scene {
  return sceneSchema.parse({
    id: uid('scene'),
    kind,
    chapterId,
    title:
      kind === 'branch'
        ? '条件分支'
        : kind === 'ending'
          ? '新的结局'
          : `视频片段 ${String(index).padStart(2, '0')}`,
    choices: [],
    events: [],
  });
}
export function makeProject(): Project {
  const scene = makeScene('video', 1);
  return {
    formatVersion: 4,
    id: uid('project'),
    title: '未命名作品',
    description: '',
    revision: 0,
    updatedAt: new Date().toISOString(),
    startNodeId: scene.id,
    settings: { width: 1920, height: 1080, author: '' },
    scenes: [scene],
    chapters: [{ id: scene.chapterId, title: '第一章', startNodeId: scene.id }],
    variables: [],
    items: [],
    assets: [],
    layout: { [scene.id]: { x: 100, y: 200 } },
  };
}

function migrateChoiceConsequences(project: LegacyProject) {
  if (!project.scenes.some(({ choices }) => choices.some((choice) => choice.effects !== undefined)))
    return;
  const newScenes: Scene[] = [];
  const usedIds = new Set([...project.scenes.map(({ id }) => id), ...Object.keys(project.layout)]);
  const eventIds = new Set(project.scenes.flatMap(({ events }) => events.map(({ id }) => id)));
  const nextRowByChapter = new Map<string, number>();
  const nodes = new Map(project.scenes.map((scene) => [scene.id, scene]));
  const incoming = new Map<string, number>();
  for (const scene of project.scenes) {
    for (const id of [scene.nextId, ...scene.choices.map((choice) => choice.targetId)])
      if (id) incoming.set(id, (incoming.get(id) ?? 0) + 1);
  }
  const entries = new Set(project.chapters.map(({ startNodeId }) => startNodeId));
  for (const scene of project.scenes) {
    const bottom = (project.layout[scene.id]?.y ?? 0) + 360 + 36 * scene.choices.length;
    nextRowByChapter.set(
      scene.chapterId,
      Math.max(nextRowByChapter.get(scene.chapterId) ?? 0, bottom),
    );
  }

  for (const scene of project.scenes) {
    for (const choice of scene.choices) {
      const legacy = choice.effects ?? [];
      delete choice.effects;
      if (!legacy.length) continue;
      const messages = legacy
        .filter((effect) => effect.kind === 'showMessage')
        .filter((effect) => effect.text.trim());
      const effects = legacy.filter((effect) => effect.kind !== 'showMessage');
      let previous: Scene | undefined;
      const originalTarget = choice.targetId;
      const target = nodes.get(originalTarget);
      const canUseTarget =
        target?.kind === 'video' &&
        (!target.choices.length || target.choicesAtMs === null) &&
        incoming.get(originalTarget) === 1 &&
        !entries.has(originalTarget);
      const consequence = (node: Scene) => {
        if (!effects.length) return;
        let id = `event_choice_${choice.id.slice(0, 125)}`;
        while (eventIds.has(id)) id += '_';
        eventIds.add(id);
        node.events.unshift({
          id,
          name: '选项后果',
          trigger: 'complete',
          atMs: 0,
          once: false,
          effects,
        });
      };
      if (!messages.length && canUseTarget) {
        consequence(target);
        continue;
      }
      const transitions = messages.length
        ? messages
        : effects.length
          ? [{ title: '选择后的剧情', text: choice.label.trim().slice(0, 500) || '故事继续。' }]
          : [];
      for (const [index, message] of transitions.entries()) {
        // Stable across reloads and independent of unrelated choices.
        let id = `scene_choice_${choice.id.slice(0, 125)}_${index + 1}`;
        while (usedIds.has(id)) id += '_';
        usedIds.add(id);
        const remaining = message.text.trim();
        const pages = [];
        let offset = 0;
        while (offset < remaining.length) {
          let end = Math.min(offset + 160, remaining.length);
          // Keep supplementary characters together when splitting a long message.
          if (
            end < remaining.length &&
            remaining.charCodeAt(end) >= 0xdc00 &&
            remaining.charCodeAt(end) <= 0xdfff
          )
            end--;
          const text = remaining.slice(offset, end).trim();
          if (text) pages.push({ text, durationMs: Math.max(3000, text.length * 160) });
          offset = end;
        }
        const node = sceneSchema.parse({
          id,
          kind: 'video',
          chapterId: scene.chapterId,
          title: message.title.trim() || '剧情过渡',
          storyboardPages: pages,
          nextId: originalTarget,
          choices: [],
          events: [],
        });
        if (previous) previous.nextId = id;
        else choice.targetId = id;
        if (index === transitions.length - 1) consequence(node);
        previous = node;
        const y = nextRowByChapter.get(scene.chapterId)!;
        project.layout[id] = { x: (project.layout[scene.id]?.x ?? 100) + 320, y };
        nextRowByChapter.set(scene.chapterId, y + 360);
        newScenes.push(node);
      }
    }
  }
  project.scenes.push(...newScenes);
}

/** Parse external projects before entering either the editor or runtime. */
export function parseProject(input: unknown): Project {
  const text = JSON.stringify(input);
  if (text.length > 30_000_000) throw new Error('工程数据超过 30 MB 限制（视频应单独存储）。');
  let depth = 0;
  const walk = (v: unknown, d: number) => {
    depth = Math.max(depth, d);
    if (d > 40) throw new Error('工程数据嵌套过深。');
    if (v && typeof v === 'object') for (const child of Object.values(v)) walk(child, d + 1);
  };
  walk(input, 0);
  const project = legacyProjectSchema.parse(migrateProject(input));
  migrateChoiceConsequences(project);
  if (project.scenes.length > 10000) throw new Error('迁移旧选项后果后，工程超过 10000 个节点。');
  for (const scene of project.scenes) {
    if (!scene.timeline) continue;
    scene.assetId =
      scene.timeline.videoClips[0]?.assetId ??
      scene.timeline.stillClips?.[0]?.assetId ??
      scene.timeline.stillAssetId;
    scene.trimStartMs = 0;
    scene.trimEndMs = undefined;
  }
  // Retain this runtime/serialization field as a derived value; chapters own the start.
  project.startNodeId = storyStartId(project);
  return project;
}

export function chapterTitle(p: Project, chapterId: string): string {
  return p.chapters.find((c) => c.id === chapterId)?.title ?? '章节已丢失';
}

export function sceneLabel(p: Project, nodeId: string): string {
  const scene = p.scenes.find((s) => s.id === nodeId);
  return scene ? `${chapterTitle(p, scene.chapterId)} / ${scene.title}` : '节点已丢失';
}
