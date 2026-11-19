import { z } from 'zod';
import type { Project } from './schema';

export const designText = z.string().trim().max(20000);
export type DesignTarget =
  { stage: 'brief' | 'outline'; chapterId?: never } | { stage: 'chapter'; chapterId: string };
export const designTargetSchema = z.union([
  z.strictObject({ stage: z.enum(['brief', 'outline']) }),
  z.strictObject({ stage: z.literal('chapter'), chapterId: z.string().min(1).max(160) }),
]);
export const sceneKeySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
function scriptScenes(text: string) {
  const headings: { sceneKey: string; title: string; start: number; end: number }[] = [];
  let current: (typeof headings)[number] | undefined;
  let fence: string | undefined;
  let offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim())
        fence = undefined;
    }
    if (!fence && /^ {0,3}#{1,2}(?:\s|$)/.test(line)) {
      if (current) current.end = offset;
      const match = /^ {0,3}##[ \t]+场次[ \t]+([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})(?=\s|$)/.exec(line);
      current = match
        ? {
            sceneKey: match[1],
            title: line.trim().replace(/^##\s+/, ''),
            start: offset,
            end: text.length,
          }
        : undefined;
      if (current) headings.push(current);
    }
    offset += line.length;
  }
  return headings;
}

export function readScriptScene(project: Project, chapterId: string, key: string) {
  const entry =
    project.chapters.some(({ id }) => id === chapterId) &&
    readDesign(project, { stage: 'chapter', chapterId });
  const matches = entry ? scriptScenes(entry.text).filter(({ sceneKey }) => sceneKey === key) : [];
  const match = matches[0];
  if (matches.length > 1) return { status: 'duplicate' } as const;
  if (!entry || !match) return { status: 'missing' } as const;
  return {
    status: 'linked',
    title: match.title,
    text: entry.text.slice(match.start, match.end).trim(),
    version: entry.version,
  } as const;
}

const entry = z.object({
  text: designText,
  confirmed: z.boolean(),
  version: z.uuid(),
  outlineVersion: z.uuid().optional(),
});
export const storyDesignSchema = z.object({
  brief: entry.optional(),
  outline: entry.optional(),
  chapters: z.array(entry.extend({ id: z.string().min(1).max(160) })).max(10000),
});

export function readDesign(project: Project, target: DesignTarget) {
  const design = project.storyDesign;
  return target.stage === 'chapter'
    ? design?.chapters.find((row) => row.id === target.chapterId)
    : design?.[target.stage];
}

export function designStatus(project: Project, target: DesignTarget) {
  const entry = readDesign(project, target);
  if (!entry) return 'missing';
  if (!entry.confirmed) return 'draft';
  if (target.stage === 'chapter' && entry.outlineVersion !== project.storyDesign?.outline?.version)
    return 'review';
  return 'confirmed';
}

export const designLabels = {
  missing: '未开始',
  draft: '草稿',
  review: '大纲已修改 · 待复核',
  confirmed: '已确认',
};

export function updateDesign(
  project: Project,
  target: DesignTarget,
  text: string,
  confirmed: boolean,
) {
  const content = designText.parse(text);
  if (target.stage === 'chapter' && !project.chapters.some(({ id }) => id === target.chapterId))
    throw new Error('目标章节不存在。');
  if (confirmed && !content) throw new Error('请先填写设计正文。');
  const current = readDesign(project, target);
  if (!current && !content) return;
  const design = (project.storyDesign ??= { chapters: [] });
  const value = {
    text: content,
    confirmed,
    version: current?.text === content ? current.version : crypto.randomUUID(),
    outlineVersion: target.stage === 'chapter' && confirmed ? design.outline?.version : undefined,
  };
  if (target.stage === 'chapter') {
    const index = design.chapters.findIndex(({ id }) => id === target.chapterId);
    if (content) {
      const row = { ...value, id: target.chapterId };
      if (index < 0) design.chapters.push(row);
      else design.chapters[index] = row;
    } else design.chapters.splice(index, 1);
  } else if (content) design[target.stage] = value;
  else delete design[target.stage];
  if (!design.brief && !design.outline && !design.chapters.length) delete project.storyDesign;
}

export function chapterHasBlueprint(project: Project, chapterId: string) {
  return project.scenes.some(
    (scene) =>
      scene.chapterId === chapterId &&
      (scene.choices.length > 0 ||
        !!scene.nextId ||
        !!scene.endingText ||
        !!scene.storyboardPages?.length ||
        !!scene.assetId ||
        !!scene.timeline?.stillAssetId ||
        !!scene.timeline?.videoClips.length ||
        !!scene.timeline?.stillClips?.length),
  );
}

export function removeChapterDesign(project: Project, chapterId: string) {
  const design = project.storyDesign;
  if (!design?.chapters.some(({ id }) => id === chapterId)) return;
  design.chapters = design.chapters.filter(({ id }) => id !== chapterId);
  if (!design.brief && !design.outline && !design.chapters.length) delete project.storyDesign;
}
