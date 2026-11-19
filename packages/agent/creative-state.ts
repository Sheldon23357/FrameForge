import { z } from 'zod';
import { resolveProjectArtStyle } from '../domain/art-style';
import {
  chapterHasBlueprint,
  designStatus,
  designTargetSchema,
  readDesign,
  type DesignTarget,
} from '../domain/story-design';
import type { Project } from '../domain/schema';

export const creativeDraftSchema = z.object({
  target: designTargetSchema,
  request: z.string().max(16000),
  text: z.string().min(1).max(20000),
  updatedAt: z.iso.datetime(),
});
export type CreativeDraft = z.infer<typeof creativeDraftSchema>;

export const sameTarget = (a: DesignTarget, b: DesignTarget) =>
  a.stage === b.stage && a.chapterId === b.chapterId;

export function creativeTarget(project: Project, chapterId?: string | null): DesignTarget {
  const chapter = project.chapters.find(({ id }) => id === chapterId) ?? project.chapters[0];
  const hasBlueprint = chapterHasBlueprint(project, chapter.id);
  if (!hasBlueprint && designStatus(project, { stage: 'outline' }) !== 'confirmed') {
    return {
      stage:
        designStatus(project, { stage: 'brief' }) === 'missing' &&
        !project.storyDesign?.outline &&
        !project.description.trim()
          ? 'brief'
          : 'outline',
    };
  }
  return { stage: 'chapter', chapterId: chapter.id };
}

const settingsFields = [
  'title',
  'description',
  'author',
  'width',
  'height',
  'artStyle',
  'atmosphereTone',
  'creativeDefaults',
] as const;

export const creativePolicySchema = z.object({
  mode: z.enum(['discuss', 'design', 'settings', 'chapter', 'execute']),
  target: designTargetSchema,
  designTargets: z.array(designTargetSchema).min(1).max(64).optional(),
  chapterDesign: z.boolean().optional(),
  flexible: z.boolean().optional(),
  fields: z.array(z.enum(settingsFields)).optional(),
  styleDescription: z.boolean().optional(),
  canConfirm: z.boolean().optional(),
  saveDiscussion: z.boolean().optional(),
  saveChapterStructure: z.boolean().optional(),
  source: z.enum(['project', 'discussion']).optional(),
  verifyBranches: z.boolean().optional(),
  discussionTurnId: z.string().min(1).max(160).optional(),
  generateReference: z.boolean().optional(),
  importAssets: z.boolean().optional(),
  chapterCount: z.number().int().min(1).max(10000).optional(),
  rememberDraft: z.boolean().optional(),
});
export type CreativePolicy = z.infer<typeof creativePolicySchema>;

export function designWriteTargets(policy: CreativePolicy) {
  return policy.designTargets ?? [policy.target];
}

export function allowsChapterDesign(policy: CreativePolicy) {
  return (
    policy.mode === 'design' &&
    Boolean(policy.chapterDesign || policy.chapterCount || policy.saveChapterStructure)
  );
}

export function discussionDesignText(draft: CreativeDraft | undefined, target: DesignTarget) {
  return draft && sameTarget(draft.target, target) ? draft.text : undefined;
}

function heading(line: string) {
  const depth = line.length - line.trimStart().length;
  if (depth > 3) return;
  const content = line.trimStart();
  let level = 0;
  while (content[level] === '#') level++;
  if (!level || level > 6 || ![' ', '\t'].includes(content[level])) return;
  return { level, text: content.slice(level).trim() };
}

export function outlineChapterSections(text: string) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  return lines.flatMap((line, index) => {
    const h = heading(line);
    if (!h?.text.startsWith('第')) return [];
    const chapterEnd = h.text.indexOf('章', 1);
    if (chapterEnd < 2) return [];
    const number = h.text.slice(1, chapterEnd);
    if (![...number].every((char) => '一二三四五六七八九十百零0123456789'.includes(char)))
      return [];
    let suffix = h.text.slice(chapterEnd + 1).trim();
    while (suffix && '：:·、—-'.includes(suffix[0])) suffix = suffix.slice(1).trimStart();
    const closingTitle = suffix.indexOf('》');
    const name =
      suffix.startsWith('《') && closingTitle > 0 ? suffix.slice(1, closingTitle) : suffix;
    let end = index + 1;
    while (end < lines.length) {
      const next = heading(lines[end]);
      if (next && next.level <= h.level) break;
      end++;
    }
    const bodyLines = lines.slice(index + 1, end);
    while (bodyLines.length) {
      const last = bodyLines.at(-1)!.trim();
      if (last && !(last.length >= 3 && [...last].every((char) => char === '-'))) break;
      bodyLines.pop();
    }
    const body = bodyLines.join('\n').trim();
    return name && body ? [{ title: `第${number}章 · ${name}`, number, body }] : [];
  });
}

export function creativeContext(
  project: Project,
  policy: CreativePolicy,
  draft?: CreativeDraft,
  unscoped = false,
) {
  const status = (stage: 'brief' | 'outline') => designStatus(project, { stage });
  const chapterId = policy.target.stage === 'chapter' ? policy.target.chapterId : undefined;
  const info = {
    settings: {
      title: project.title,
      width: project.settings.width,
      height: project.settings.height,
      artStyle: resolveProjectArtStyle(project.settings)?.preset ?? null,
      atmosphereTone: project.settings.atmosphereTone,
      creativeDefaults: project.settings.creativeDefaults,
    },
    brief: status('brief'),
    outline: status('outline'),
    chapter: chapterId
      ? {
          id: chapterId,
          design: designStatus(project, { stage: 'chapter', chapterId }),
          hasBlueprint: chapterHasBlueprint(project, chapterId),
        }
      : undefined,
  };
  const instructions = {
    discuss:
      '本轮只在对话中交流。创作意图还在探索时，围绕用户已经描述的内容提一两个开放问题，问完等用户回答。用户要求起草时，简报整理已明确的构想和待定项，大纲展开章节骨架和关键分歧，章节按场次写情节、路线与选择后果，用叙述概括角色说了什么。多章正文用独立 Markdown 章标题，例如「## 第一章《章名》」。优先沿用用户已确定的内容。',
    design:
      '本轮保存用户指定的作者文本。designTargets（若有）列出全部指定范围，简报和大纲用 edit_story_design 保存。拆解大纲用 edit_chapter 的 designText 逐章保存，每次响应优先完成一章。保存已写好的设计时沿用其正文。若用户明确要求确认，用 action=confirm 保存并确认宿主找到的工程正文或讨论稿；个别文档若没有可确认的正文，说明该项缺失并继续处理其余指定文档。按工具实际结果汇报每份文档。',
    settings: '本轮只更新用户指定的作品设置。沿用现有字段，勿补写简介、详细画风或剧情。',
    chapter:
      '按用户指定的章节和交付物工作。作者正文沿用相关设计与草案，按写入回执验收。用户要求搭建试玩时，复用已有入口与素材，编辑相关节点并检查受影响的路线。',
    execute:
      '直接执行用户要求的工程改动。已有合适的简报、大纲和章节正文时先读取并沿用。若用户说“开始编辑”，从最近商定的可执行任务开始；缺少可确定的任务时再询问。不要顺带完成相邻阶段。',
  };
  const entry = readDesign(project, policy.target);
  return `本轮创作策略：${unscoped ? '按用户意图直接回答，或在同一工具批次声明并执行工程操作。讨论建议：' + instructions.discuss : instructions[policy.mode]}\n新作品的策划可依次确定全局设置、大纲和剧本。只执行本轮要求的阶段，沿用已有信息。\n状态与本轮范围（参考数据）：${JSON.stringify(
    {
      ...info,
      ...(unscoped ? { suggestedTarget: policy.target } : policy),
      currentDesign: entry?.text.slice(0, 1800),
      ...(policy.mode === 'design' && policy.canConfirm
        ? {
            confirmableDesigns: designWriteTargets(policy).filter(
              (target) => readDesign(project, target)?.text || discussionDesignText(draft, target),
            ),
          }
        : {}),
      recentDraft: draft
        ? {
            ...draft,
            request: draft.request.slice(0, 600),
            text: draft.text.slice(0, 5000),
            truncated: draft.text.length > 5000,
          }
        : undefined,
    },
  )}`;
}
