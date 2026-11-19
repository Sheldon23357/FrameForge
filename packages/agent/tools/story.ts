import { z } from 'zod';
import { projectNotePreview } from '../note-preview';
import { removeProductionShots } from '../../domain/production-shots';
import { removeScreenplays } from '../../domain/screenplay';
import { designText, removeChapterDesign, updateDesign } from '../../domain/story-design';
import {
  always,
  chapterSchema,
  choiceQuestionMaxLength,
  choiceSchema,
  conditionSchema,
  eventSchema,
  makeChoice,
  makeScene,
  sceneSchema,
  storyboardPagesSchema,
  uid,
  type Project,
} from '../../domain/schema';
import { snapStoryTime } from '../../domain/story-time';
import { nodeDuration, playerTextPlayback } from '../../domain/timeline';
import { ToolRegistry } from './registry';
import { normalizeNumericField } from './numeric-input';

function normalizeStoryboardDurations(input: unknown) {
  if (!input || typeof input !== 'object' || !('storyboardPages' in input)) return input;
  if (!Array.isArray(input.storyboardPages)) return input;
  return {
    ...input,
    storyboardPages: input.storyboardPages.map((page) => normalizeNumericField(page, 'durationMs')),
  };
}
import type { ToolContext, ToolResult } from '../types';

const id = z.string().min(1).max(160);
const choiceLabelDescription =
  '玩家可见的选项文案。Agent 新拟或改写时最多 12 个字符，标点和空格也计入。';
const nodeContentDescription =
  '节点内容，供作者与后续拆分镜使用。新写或改写时在 notes 内明确分四项。「从哪来」写实际前置节点或选择及进场处境。「已知与持有」写进场已知事实、道具及来路差异。「这一段新增什么」按顺序写行动、对白意图、线索揭露与结算，标明选择前须交代的信息。「往哪去」写自动出口、各选项或条件的去向与离场状态。汇流区分共同事实和路线专属事实。章首、结局或无新增道具时如实写明。';
const newNodeContent = sceneSchema.shape.notes
  .unwrap()
  .trim()
  .min(1, '请填写节点内容（notes）。')
  .describe(nodeContentDescription);
const choiceQuestionField = sceneSchema.shape.choiceQuestion.describe(
  `仅视频节点可设置。此问题显示在整组玩家选项上方，最多 ${choiceQuestionMaxLength} 个字符，标点和空格也计入。传空字符串清空；省略时不修改。`,
);
const conditionJson = z
  .string()
  .max(20000)
  .describe(
    '条件 JSON。无条件 {"kind":"all","children":[]}；道具 {"kind":"item","itemId":"实际ID","op":"gte","count":1}；属性 {"kind":"variable","variableId":"实际ID","op":"gte","value":50}；组合用 all/any 的 children 或 not 的 child。',
  );
function normalizeEventEffects(effects: unknown) {
  if (!Array.isArray(effects)) return effects;
  return effects.map((effect) => {
    if (effect?.kind === 'addVariable') return normalizeNumericField(effect, 'value');
    if (effect?.kind === 'addItem' || effect?.kind === 'removeItem')
      return normalizeNumericField(effect, 'count');
    return effect;
  });
}

const scene = (c: ToolContext, nodeId: string) => {
  const s = c.project.scenes.find((s) => s.id === nodeId);
  if (!s) throw new Error(`节点 ${nodeId} 不存在，请先查询实际 ID。`);
  return s;
};
const chapter = (p: Project, chapterId: string) => {
  const c = p.chapters.find((c) => c.id === chapterId);
  if (!c) throw new Error('章节不存在。');
  return c;
};
function repair(p: Project) {
  for (const c of p.chapters)
    if (!p.scenes.some((s) => s.id === c.startNodeId && s.chapterId === c.id))
      c.startNodeId = p.scenes.find((s) => s.chapterId === c.id)?.id ?? '';
}
const ok = (summary: string, data?: unknown, nodeIds?: string[]): ToolResult => ({
  ok: true,
  summary,
  data,
  nodeIds,
});
const choicePatch = choiceSchema
  .omit({ id: true, condition: true })
  .partial()
  .extend({
    label: choiceSchema.shape.label.describe(choiceLabelDescription).optional(),
    conditionJson: conditionJson.optional(),
    lockedText: choiceSchema.shape.lockedText.unwrap().optional(),
    hiddenWhenLocked: choiceSchema.shape.hiddenWhenLocked.unwrap().optional(),
  })
  .strict();
// A patch must not materialize scene creation defaults for omitted fields.
const scenePatch = sceneSchema
  .omit({
    id: true,
    kind: true,
    choices: true,
    events: true,
    timeline: true,
    settingIds: true,
    storyboardScreenplayVersion: true,
  })
  .partial()
  .extend({
    notes: sceneSchema.shape.notes
      .unwrap()
      .describe(`${nodeContentDescription} 传入完整的新正文，空字符串清空。`)
      .optional(),
    durationMs: sceneSchema.shape.durationMs.unwrap().optional(),
    trimStartMs: sceneSchema.shape.trimStartMs.unwrap().optional(),
    choiceQuestion: choiceQuestionField,
    choicesAtMs: sceneSchema.shape.choicesAtMs
      .unwrap()
      .describe('选项出现的节点内时间，单位毫秒；null 表示片尾。保存时按 100 毫秒取整。')
      .optional(),
    choiceMode: sceneSchema.shape.choiceMode.unwrap().optional(),
    nextId: sceneSchema.shape.nextId.unwrap().optional(),
    endingLabel: sceneSchema.shape.endingLabel.unwrap().optional(),
    endingText: sceneSchema.shape.endingText.unwrap().optional(),
  });
export function storyTopology(project: Project, chapterId?: string, offset = 0, limit = 24) {
  const nodes = chapterId
    ? project.scenes.filter((node) => node.chapterId === chapterId)
    : project.scenes;
  const rows = nodes.slice(offset, offset + limit).map((node) => ({
    id: node.id,
    chapterId: node.chapterId,
    title: node.title,
    kind: node.kind,
    nextId: node.nextId || undefined,
    pages: node.storyboardPages?.length ?? 0,
    choiceCount: node.choices.length,
    choices: node.choices.slice(0, 8).map(({ id, label, targetId }) => ({ id, label, targetId })),
  }));
  const chapterIds = new Set(rows.map((node) => node.chapterId));
  if (chapterId) chapterIds.add(chapterId);
  return {
    startNodeId: project.startNodeId,
    chapters: project.chapters
      .filter((chapter) => chapterIds.has(chapter.id))
      .map(({ id, startNodeId }) => ({ id, startNodeId })),
    total: nodes.length,
    offset,
    nextOffset: offset + rows.length < nodes.length ? offset + rows.length : null,
    nodes: rows,
  };
}

export const storyOverviewCharacters = 32_000;

export const storyOverviewNode = (scene: Project['scenes'][number]) => ({
  id: scene.id,
  chapterId: scene.chapterId,
  title: scene.title,
  kind: scene.kind,
  nextId: scene.nextId || undefined,
  choices: scene.choices.slice(0, 8).map(({ id, label, targetId }) => [id, label, targetId]),
  moreChoices: scene.choices.length > 8 ? scene.choices.length - 8 : undefined,
  pages: scene.storyboardPages?.map(({ text }) => text),
  pageDurationsMs: scene.storyboardPages?.map(({ durationMs }) => durationMs),
  ending: scene.endingText || undefined,
});

export function registerStoryTools(r: ToolRegistry) {
  r.register({
    name: 'insert_story_scene',
    label: '插入剧情过场',
    group: 'story',
    mode: 'write',
    description:
      '在视频节点的现有自动出口插入过场。提供上游节点真实 ID、完整节点内容 notes 和玩家剧情文字 storyboardPages。一次完成创建和两侧连线，保留原去向。',
    schema: z.object({
      fromId: id,
      title: z.string().trim().min(1).max(200),
      notes: newNodeContent,
      storyboardPages: storyboardPagesSchema.min(1),
    }),
    normalizeArguments: normalizeStoryboardDurations,
    execute: (context, args) => {
      const from = scene(context, args.fromId);
      if (from.kind !== 'video' || from.choices.length || !from.nextId)
        throw new Error('请选择有自动出口、没有选项的视频节点。');
      const to = scene(context, from.nextId);
      const inserted = makeScene('video', context.project.scenes.length + 1, from.chapterId);
      inserted.title = args.title;
      inserted.notes = args.notes;
      inserted.storyboardPages = args.storyboardPages;
      inserted.nextId = to.id;
      from.nextId = inserted.id;
      context.project.scenes.splice(context.project.scenes.indexOf(from) + 1, 0, inserted);
      const position = context.project.layout[from.id];
      context.project.layout[inserted.id] = {
        x: (position?.x ?? 100) + 300,
        y: (position?.y ?? 100) + 140,
      };
      return ok(
        `已插入「${inserted.title}」，并接回「${to.title}」`,
        { nodeId: inserted.id, fromId: from.id, toId: to.id },
        [from.id, inserted.id],
      );
    },
  });
  r.register({
    name: 'read_story_overview',
    label: '通读剧情',
    group: 'story',
    mode: 'read',
    description:
      '按章或全剧连续读取正文、每页时长 pageDurationsMs、节点 ID 和出边。可选 chapterId；按 nextOffset 续读。',
    schema: z.object({
      chapterId: id.optional(),
      offset: z.number().int().nonnegative().default(0),
    }),
    execute: ({ project, readPageCharacters }, { chapterId, offset }) => {
      if (chapterId) chapter(project, chapterId);
      const chapters = project.chapters.filter((entry) => !chapterId || entry.id === chapterId);
      const chapterScenes = new Map(chapters.map(({ id }) => [id, [] as Project['scenes']]));
      for (const scene of project.scenes) chapterScenes.get(scene.chapterId)?.push(scene);
      const scenes = [...chapterScenes.values()].flat();
      const chapterRows = new Map(
        chapters.map(({ id, title, startNodeId }) => [id, { id, title, startNodeId }]),
      );
      const nodes: ReturnType<typeof storyOverviewNode>[] = [];
      const data = {
        chapters: [] as { id: string; title: string; startNodeId: string }[],
        startNodeId: project.startNodeId,
        total: scenes.length,
        offset,
        nextOffset: offset < scenes.length ? offset : null,
        nodes,
      };
      const budget = Math.min(
        storyOverviewCharacters,
        readPageCharacters ?? storyOverviewCharacters,
      );
      for (const scene of scenes.slice(offset)) {
        const newChapter = data.chapters.at(-1)?.id !== scene.chapterId;
        if (newChapter) data.chapters.push(chapterRows.get(scene.chapterId)!);
        nodes.push(storyOverviewNode(scene));
        if (JSON.stringify(data).length + 32 > budget) {
          nodes.pop();
          if (newChapter) data.chapters.pop();
          break;
        }
      }
      const next = offset + nodes.length;
      data.nextOffset = next < scenes.length ? next : null;
      if (!nodes.length && data.nextOffset !== null)
        return {
          ok: false,
          summary:
            '剩余预算不足以读取下一个完整节点。单独调用 overview 从同一 offset 继续，或用 read 分页读取该节点。',
          data: { offset, nextOffset: offset, nodeId: scenes[offset].id },
        };
      return ok(`通读 ${nodes.length}/${scenes.length} 个剧情节点`, data);
    },
  });
  r.register({
    name: 'move_scenes',
    label: '移动节点到章节',
    group: 'story',
    mode: 'write',
    description: '批量移章。省略 nodeIds 时使用发送消息时用户选中的全部节点。',
    schema: z.object({ nodeIds: z.array(id).max(1000).optional(), chapterId: id }),
    execute: (c, a) => {
      chapter(c.project, a.chapterId);
      const ids = a.nodeIds ?? c.selectedIds;
      if (!ids.length) throw new Error('未选中节点。');
      for (const nodeId of ids) scene(c, nodeId).chapterId = a.chapterId;
      repair(c.project);
      return ok(`移动 ${ids.length} 个节点到目标章节`, { chapterId: a.chapterId }, ids);
    },
  });
  r.register({
    name: 'list_scenes',
    label: '查询剧情节点',
    group: 'story',
    mode: 'read',
    description: '按类型、章节或关键词检索节点的真实 ID，分页返回；kind=ending 只查结局。',
    schema: z.object({
      kind: sceneSchema.shape.kind.optional(),
      chapterId: id.optional(),
      query: z.string().max(200).optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    execute: (c, a) => {
      const query = a.query?.toLowerCase();
      const rows = c.project.scenes.filter(
        (s) =>
          (!a.kind || s.kind === a.kind) &&
          (!a.chapterId || s.chapterId === a.chapterId) &&
          (!query ||
            `${s.title} ${s.notes} ${s.choiceQuestion ?? ''}`.toLowerCase().includes(query) ||
            s.storyboardPages?.some((page) => page.text.toLowerCase().includes(query))),
      );
      return ok(`找到 ${rows.length} 个节点`, {
        total: rows.length,
        offset: a.offset,
        nextOffset: a.offset + a.limit < rows.length ? a.offset + a.limit : null,
        nodes: rows.slice(a.offset, a.offset + a.limit).map((s) => ({
          id: s.id,
          title: s.title,
          kind: s.kind,
          chapterId: s.chapterId,
          assetId: s.assetId,
          storyboardPageCount: s.storyboardPages?.length ?? 0,
          nextId: s.nextId,
          choiceQuestion: s.choiceQuestion,
          choiceCount: s.choices.length,
        })),
      });
    },
  });
  r.register({
    name: 'read_story_topology',
    label: '读取章节拓扑',
    group: 'story',
    mode: 'read',
    description:
      '读取章入口、节点真实 ID、自动出口、前八个选项的 ID 与目标。choiceCount 大于八时用 read 的 choices 分页。只含连线摘要，改正文时再读取 storyboard。',
    schema: z.object({
      chapterId: id.optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(50),
    }),
    execute: ({ project, readPageCharacters }, { chapterId, offset, limit }) => {
      if (chapterId) chapter(project, chapterId);
      let topology = storyTopology(project, chapterId, offset, limit);
      const budget = Math.min(14_000, readPageCharacters ?? 14_000);
      while (topology.nodes.length > 1 && JSON.stringify(topology).length > budget)
        topology = storyTopology(project, chapterId, offset, Math.ceil(topology.nodes.length / 2));
      return ok(`读取 ${topology.nodes.length}/${topology.total} 个节点的连线`, topology);
    },
  });
  r.register({
    name: 'read_scene',
    label: '读取节点详情',
    group: 'story',
    mode: 'read',
    description:
      '读取单个节点。all 返回概要及节点内容摘要，拆分镜前用 section=notes 分页读取完整节点内容。storyboard 按页读取玩家剧情文字和时长；choices 返回整组选项的问题 choiceQuestion 和分页选项。多个独立节点优先使用 read_batch。',
    schema: z.object({
      nodeId: id,
      section: z.enum(['all', 'choices', 'events', 'notes', 'storyboard']).default('all'),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(25).default(15),
    }),
    execute: (c, a) => {
      const s = scene(c, a.nodeId);
      const { choices, events, notes, timeline, storyboardPages = [], ...meta } = s;
      if (a.section === 'storyboard') {
        return ok(`读取「${s.title}」的剧情文字`, {
          id: s.id,
          storyboardOverlay: s.storyboardOverlay ?? false,
          playerTextPlayback: playerTextPlayback(c.project, s),
          total: storyboardPages.length,
          offset: a.offset,
          nextOffset: a.offset + a.limit < storyboardPages.length ? a.offset + a.limit : null,
          pages: storyboardPages.slice(a.offset, a.offset + a.limit),
        });
      }
      return ok(
        `读取「${s.title}」`,
        a.section === 'notes'
          ? {
              id: s.id,
              chapterId: s.chapterId,
              notes: notes.slice(a.offset, a.offset + 4000),
              totalCharacters: notes.length,
              nextOffset: a.offset + 4000 < notes.length ? a.offset + 4000 : null,
            }
          : a.section === 'choices'
            ? {
                id: s.id,
                choiceQuestion: s.choiceQuestion,
                total: choices.length,
                nextOffset: a.offset + a.limit < choices.length ? a.offset + a.limit : null,
                choices: choices.slice(a.offset, a.offset + a.limit),
              }
            : a.section === 'events'
              ? {
                  id: s.id,
                  total: events.length,
                  events: events.slice(a.offset, a.offset + a.limit),
                }
              : {
                  ...meta,
                  timeline: timeline
                    ? {
                        videoCount: timeline.videoClips.length,
                        audioCount: timeline.audioClips.length,
                        stillAssetId: timeline.stillAssetId,
                        stillCount: timeline.stillClips?.length ?? (timeline.stillAssetId ? 1 : 0),
                        retrieval: 'read_story.timeline',
                      }
                    : undefined,
                  notes: projectNotePreview(notes),
                  noteCharacters: notes.length,
                  storyboardPageCount: storyboardPages.length,
                  choices: choices.slice(0, a.limit),
                  choiceCount: choices.length,
                  events: events.slice(0, a.limit),
                  eventCount: events.length,
                },
      );
    },
  });
  r.register({
    name: 'create_scene',
    label: '创建剧情节点',
    group: 'story',
    mode: 'write',
    description:
      '创建视频节点、条件分支或结局，提供供制作使用的完整节点内容 notes。返回新 ID。没有可绑定的视频或图片时，视频节点同时提供 storyboardPages，可先写简短的玩家可读占位文字供蓝图试玩。新条件分支须在本轮内补齐有目标的兜底选项。每条新建结局路线先用独立视频节点演完结局剧情，再用 connect 自动连到 ending 总结节点。',
    schema: z.object({
      kind: z
        .enum(['video', 'branch', 'ending'])
        .describe(
          'video 可挂玩家可点击选项，branch 自动选择符合条件的出口，ending 只显示结局总结，结局剧情放在前一个 video 节点。',
        ),
      title: z.string().min(1).max(200),
      chapterId: id.optional(),
      assetId: id.optional(),
      notes: newNodeContent,
      choiceQuestion: choiceQuestionField,
      storyboardPages: storyboardPagesSchema.optional(),
      endingText: z.string().max(10000).optional(),
      durationMs: z.number().positive().optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
    }),
    normalizeArguments: normalizeStoryboardDurations,
    execute: (c, a) => {
      const chapterId =
        a.chapterId ??
        c.activeChapterId ??
        c.project.scenes.find((s) => c.selectedIds.includes(s.id))?.chapterId ??
        c.project.chapters[0].id;
      chapter(c.project, chapterId);
      if (a.assetId && !c.project.assets.some((v) => v.id === a.assetId && v.type !== 'audio'))
        throw new Error('素材不存在或是纯音频。');
      if (a.kind === 'video' && !a.assetId && !a.storyboardPages?.length)
        throw new Error('未绑定视频或图片的新节点需要至少一页剧情文字（storyboardPages）。');
      if (a.kind !== 'video' && a.storyboardPages?.length)
        throw new Error('只有视频节点可以使用占位剧情文字。');
      if (a.kind !== 'video' && a.choiceQuestion?.trim())
        throw new Error('只有视频节点可以设置互动问题。');
      const s = makeScene(a.kind, c.project.scenes.length + 1, chapterId);
      Object.assign(
        s,
        { title: a.title, notes: a.notes },
        a.assetId ? { assetId: a.assetId } : {},
        a.choiceQuestion?.trim() ? { choiceQuestion: a.choiceQuestion.trim() } : {},
        a.storyboardPages?.length ? { storyboardPages: a.storyboardPages } : {},
        a.endingText !== undefined ? { endingText: a.endingText } : {},
        a.durationMs ? { durationMs: a.durationMs } : {},
      );
      c.project.scenes.push(s);
      c.project.layout[s.id] = {
        x: a.x ?? 160 + (c.project.scenes.length % 5) * 300,
        y: a.y ?? Math.floor(c.project.scenes.length / 5) * 200 + 100,
      };
      repair(c.project);
      return ok(`创建「${s.title}」`, { nodeId: s.id, chapterId }, [s.id]);
    },
  });
  r.register({
    name: 'update_scene',
    label: '修改剧情节点',
    group: 'story',
    mode: 'write',
    description:
      '按真实 ID 修改节点字段。patch.notes 替换供拆分镜使用的节点内容，分从哪来、已知与持有、这一段新增什么、往哪去四项。改剧情或路线时同步更新受影响的节点内容。storyboardPages 替换玩家剧情文字，可将蓝图阶段的占位改为节点制作定稿，传空数组清除。choiceQuestion 修改视频节点的整组互动问题，传空字符串清除。玩家可见的结局总结使用 endingText。选项和事件使用各自工具。',
    schema: z.object({
      nodeId: id,
      patch: scenePatch,
    }),
    normalizeArguments: (input) => {
      if (!input || typeof input !== 'object' || !('patch' in input)) return input;
      return {
        ...input,
        patch: normalizeStoryboardDurations(input.patch),
      };
    },
    execute: (c, a) => {
      const s = scene(c, a.nodeId);
      if (s.kind !== 'video' && (a.patch.storyboardPages?.length || a.patch.storyboardOverlay))
        throw new Error('只有视频节点可以使用剧情文字。');
      const { choiceQuestion, ...patch } = a.patch;
      if (s.kind !== 'video' && choiceQuestion?.trim())
        throw new Error('只有视频节点可以设置互动问题。');
      if (
        s.timeline &&
        ['assetId', 'trimStartMs', 'trimEndMs', 'durationMs'].some((key) => key in a.patch)
      )
        throw new Error('此节点已使用时间线，请使用 edit_timeline 修改素材和裁剪。');
      if (a.patch.chapterId) chapter(c.project, a.patch.chapterId);
      if (a.patch.nextId) scene(c, a.patch.nextId);
      if (
        a.patch.assetId &&
        !c.project.assets.some((v) => v.id === a.patch.assetId && v.type !== 'audio')
      )
        throw new Error('素材不存在或类型不支持。');
      Object.assign(s, patch);
      if (a.patch.storyboardPages !== undefined) {
        const version = c.screenplaySourceVersion?.(s.id);
        if (version) s.storyboardScreenplayVersion = version;
      }
      if (choiceQuestion !== undefined) {
        const question = choiceQuestion.trim();
        if (question) s.choiceQuestion = question;
        else delete s.choiceQuestion;
      }
      if (typeof a.patch.choicesAtMs === 'number')
        s.choicesAtMs = snapStoryTime(a.patch.choicesAtMs, nodeDuration(c.project, s));
      repair(c.project);
      return ok(`修改「${s.title}」`, { nodeId: s.id, fields: Object.keys(a.patch) }, [s.id]);
    },
  });
  r.register({
    name: 'delete_scene',
    label: '删除剧情节点',
    group: 'story',
    mode: 'write',
    description:
      '删除指定节点及布局；可同时删除指向它的选项。访问条件引用等仍需用工具修复，通过校验后才会提交。',
    schema: z.object({ nodeId: id, removeIncomingChoices: z.boolean().default(false) }),
    execute: (c, a) => {
      const s = scene(c, a.nodeId);
      c.project.scenes = c.project.scenes.filter((s) => s.id !== a.nodeId);
      removeProductionShots(c.project, [a.nodeId]);
      removeScreenplays(c.project, [a.nodeId]);
      delete c.project.layout[a.nodeId];
      for (const n of c.project.scenes) {
        if (n.nextId === a.nodeId) n.nextId = '';
        if (a.removeIncomingChoices) n.choices = n.choices.filter((v) => v.targetId !== a.nodeId);
        else for (const v of n.choices) if (v.targetId === a.nodeId) v.targetId = '';
      }
      repair(c.project);
      return ok(`删除「${s.title}」`, { nodeId: a.nodeId }, [a.nodeId]);
    },
  });
  r.register({
    name: 'connect_scenes',
    label: '连接剧情节点',
    group: 'story',
    mode: 'write',
    description: '设置没有选项的视频节点播完后跳往哪里。交互选项的跳转请用 edit_choice。',
    schema: z.object({ fromId: id, toId: id }),
    execute: (c, a) => {
      const s = scene(c, a.fromId);
      scene(c, a.toId);
      if (s.kind !== 'video' || s.choices.length)
        throw new Error('该节点须通过选项连接，请使用选项工具。');
      s.nextId = a.toId;
      return ok(`连接「${s.title}」的自动跳转`, a, [s.id, a.toId]);
    },
  });
  r.register({
    name: 'edit_choice',
    label: '编辑剧情选项',
    group: 'story',
    category: 'choices',
    mode: 'write',
    description:
      '新增、修改或删除一个剧情选项，action、nodeId、choiceId 和 patch 放在同一层。add 必须提供跳转目标，默认无条件；update 按真实选项 ID 修改，省略的字段保留；delete 删除选项。选项后果用 edit_event 写到选项跳转后的视频节点，trigger=complete。多条路线共用目标且后果不同时，先用 edit_scene 创建独立的视频剧情节点再接回共用路线。',
    schema: z.discriminatedUnion('action', [
      z.strictObject({
        action: z.literal('add'),
        nodeId: id,
        label: z.string().min(1).max(500).describe(choiceLabelDescription),
        targetId: id,
        conditionJson: conditionJson.optional(),
        hiddenWhenLocked: z.boolean().optional(),
        lockedText: z.string().max(500).optional(),
        index: z.number().int().nonnegative().optional(),
      }),
      z.strictObject({
        action: z.literal('update'),
        nodeId: id,
        choiceId: id,
        patch: choicePatch,
      }),
      z.strictObject({ action: z.literal('delete'), nodeId: id, choiceId: id }),
    ]),
    execute: (c, a) => {
      const s = scene(c, a.nodeId);
      if (a.action === 'delete') {
        if (!s.choices.some((v) => v.id === a.choiceId)) throw new Error('选项不存在。');
        s.choices = s.choices.filter((v) => v.id !== a.choiceId);
        return ok('删除选项', { nodeId: a.nodeId, choiceId: a.choiceId }, [s.id]);
      }
      if (a.action === 'update') {
        const choice = s.choices.find((v) => v.id === a.choiceId);
        if (!choice) throw new Error('选项不存在。');
        const { conditionJson, ...patch } = a.patch;
        if (patch.targetId) scene(c, patch.targetId);
        Object.assign(choice, patch);
        if (conditionJson !== undefined)
          choice.condition = conditionSchema.parse(JSON.parse(conditionJson));
        return ok(
          `修改选项「${choice.label}」`,
          { choiceId: choice.id, fields: Object.keys(a.patch) },
          [s.id],
        );
      }
      scene(c, a.targetId);
      if (s.kind === 'ending') throw new Error('结局节点不能添加选项。');
      const choice = {
        ...makeChoice(a.label),
        targetId: a.targetId,
        condition: a.conditionJson ? conditionSchema.parse(JSON.parse(a.conditionJson)) : always(),
        hiddenWhenLocked: a.hiddenWhenLocked ?? false,
        lockedText: a.lockedText ?? '尚未满足条件',
      };
      s.choices.splice(a.index ?? s.choices.length, 0, choice);
      return ok(`在「${s.title}」添加选项「${a.label}」`, { choiceId: choice.id, nodeId: s.id }, [
        s.id,
      ]);
    },
  });
  r.register({
    name: 'edit_event',
    label: '编辑节点事件',
    group: 'story',
    category: 'choices',
    mode: 'write',
    description:
      'save 创建事件或按 eventId 更新事件；delete 按节点和事件 ID 删除。effects 为完整效果列表，支持 showMessage（title、text）剧情反馈；enter/time/exit/complete 分别表示进入、片段时间点、离开、视频自然播放完成。选项引起的属性和道具变化放在选项后视频节点的 complete 事件，提前跳转不会触发。',
    schema: z.discriminatedUnion('action', [
      eventSchema
        .omit({ id: true })
        .extend({
          action: z.literal('save'),
          nodeId: id,
          eventId: id.optional(),
          atMs: eventSchema.shape.atMs.describe(
            '节点内时间，单位毫秒；time 事件保存时按 100 毫秒取整。',
          ),
        })
        .strict(),
      z.strictObject({ action: z.literal('delete'), nodeId: id, eventId: id }),
    ]),
    normalizeArguments: (input) =>
      input && typeof input === 'object' && 'effects' in input
        ? { ...input, effects: normalizeEventEffects(input.effects) }
        : input,
    execute: (c, a) => {
      const s = scene(c, a.nodeId);
      if (a.action === 'delete') {
        if (!s.events.some((e) => e.id === a.eventId)) throw new Error('事件不存在。');
        s.events = s.events.filter((e) => e.id !== a.eventId);
        return ok('删除事件', { nodeId: a.nodeId, eventId: a.eventId }, [s.id]);
      }
      const { action: _action, nodeId: _nodeId, eventId, ...fields } = a;
      if (fields.trigger === 'complete' && s.kind !== 'video')
        throw new Error('播放完成事件只能添加到视频节点。');
      if (fields.trigger === 'time')
        fields.atMs = snapStoryTime(fields.atMs, nodeDuration(c.project, s));
      if (eventId) {
        const e = s.events.find((v) => v.id === eventId);
        if (!e) throw new Error('事件不存在。');
        Object.assign(e, fields);
        return ok(`修改事件「${a.name}」`, { eventId }, [s.id]);
      }
      const e = { ...fields, id: uid('event') };
      s.events.push(e);
      return ok(`创建事件「${a.name}」`, { eventId: e.id }, [s.id]);
    },
  });
  const chapterDraftText = designText.min(1).optional();
  r.register({
    name: 'edit_chapter',
    label: '编辑章节',
    group: 'story',
    mode: 'write',
    description:
      'create 新建章节并返回 ID；update 按已有章节 ID 改名、改起点或排序。patch.title 修改分章节大纲及章节目录显示的章节标题，正文中的 Markdown 标题由 designText 单独编辑。逐章撰写设计时，每章用一次调用，在 create 或 update 同时传 designText 保存完整正文草稿。已有章节传真实 chapterId，仅写正文时传 patch={}。起点必须属于本章，第一章起点也是全作开场。delete 删除章节；有节点时必须提供 targetChapterId，节点和连线会保留。',
    schema: z.discriminatedUnion('action', [
      z.strictObject({
        action: z.literal('create'),
        title: z.string().trim().min(1).max(200),
        designText: chapterDraftText,
      }),
      z.strictObject({
        action: z.literal('update'),
        chapterId: id,
        patch: chapterSchema.omit({ id: true, startNodeId: true }).partial().extend({
          startNodeId: chapterSchema.shape.startNodeId.unwrap().optional(),
        }),
        index: z.number().int().nonnegative().optional(),
        designText: chapterDraftText,
      }),
      z.strictObject({
        action: z.literal('delete'),
        chapterId: id,
        targetChapterId: id.optional(),
      }),
    ]),
    execute: (c, a) => {
      if (a.action === 'create') {
        if (c.project.chapters.some((v) => v.title === a.title)) throw new Error('存在同名章节。');
        const row = { id: uid('chapter'), title: a.title, startNodeId: '' };
        c.project.chapters.push(row);
        if (a.designText)
          updateDesign(c.project, { stage: 'chapter', chapterId: row.id }, a.designText, false);
        return ok(
          a.designText ? `已创建并写入「${row.title}」设计正文` : `创建章节「${row.title}」`,
          row,
        );
      }
      if (a.action === 'delete') {
        chapter(c.project, a.chapterId);
        if (c.project.chapters.length === 1) throw new Error('至少保留一个章节。');
        const members = c.project.scenes.filter((s) => s.chapterId === a.chapterId);
        if (members.length) {
          if (!a.targetChapterId || a.targetChapterId === a.chapterId)
            throw new Error('须提供有效的接收章节。');
          chapter(c.project, a.targetChapterId);
          members.forEach((s) => (s.chapterId = a.targetChapterId!));
        }
        c.project.chapters = c.project.chapters.filter((v) => v.id !== a.chapterId);
        removeChapterDesign(c.project, a.chapterId);
        repair(c.project);
        return ok(
          '删除章节并保留节点',
          { moved: members.length },
          members.map((s) => s.id),
        );
      }
      const v = chapter(c.project, a.chapterId);
      if (
        a.patch.title &&
        c.project.chapters.some((n) => n.id !== v.id && n.title === a.patch.title)
      )
        throw new Error('存在同名章节。');
      if (a.patch.startNodeId && scene(c, a.patch.startNodeId).chapterId !== v.id)
        throw new Error('章节起点须属于本章。');
      Object.assign(v, a.patch);
      if (a.index !== undefined) {
        c.project.chapters = c.project.chapters.filter((n) => n.id !== v.id);
        c.project.chapters.splice(a.index, 0, v);
      }
      if (a.designText)
        updateDesign(c.project, { stage: 'chapter', chapterId: v.id }, a.designText, false);
      return ok(a.designText ? `已写入「${v.title}」设计正文` : `修改章节「${v.title}」`, v);
    },
  });
}
