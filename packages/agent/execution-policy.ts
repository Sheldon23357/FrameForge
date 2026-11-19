import type { Project } from '../domain/schema';
import type { ToolContext } from './types';
import {
  allowsChapterDesign,
  designWriteTargets,
  sameTarget,
  type CreativePolicy,
} from './creative-state';
const json = JSON.stringify;

export const chapterWriteTools = new Set([
  'edit_scene',
  'delete_scene',
  'edit_choice',
  'edit_event',
  'edit_chapter',
  'edit_timeline',
  'edit_world_setting',
  'arrange_nodes',
  'edit_game_data',
  'edit_production_shot',
  'generate_world_reference',
  'generate_shot_image',
  'generate_image_batch',
  'generate_production_audio',
  'import_assets',
]);

export function chapterOutsideScope(before: Project, after: Project, chapterId: string) {
  const other = (project: Project) => {
    const scenes = project.scenes.filter((scene) => scene.chapterId !== chapterId);
    return {
      scenes,
      chapters: project.chapters.filter((chapter) => chapter.id !== chapterId),
      chapterOrder: project.chapters.map(({ id }) => id),
      layout: scenes.map(({ id }) => project.layout[id]),
      shots:
        project.productionShots?.filter((shot) => scenes.some(({ id }) => id === shot.nodeId)) ??
        [],
    };
  };
  return json(other(before)) !== json(other(after));
}

export function scopeError(
  policy: CreativePolicy,
  name: string,
  raw: string,
  designConfirmations: NonNullable<ToolContext['designConfirmations']>,
  settingsApplied: ReadonlySet<string>,
) {
  try {
    const args = JSON.parse(raw);
    if (
      name === 'edit_chapter' &&
      policy.mode === 'design' &&
      (!allowsChapterDesign(policy) ||
        (args.action !== 'create' &&
          !(
            args.action === 'update' &&
            args.index === undefined &&
            Object.keys(args.patch ?? {}).every((key) => key === 'title')
          )))
    )
      return { ok: false, summary: '章节设计范围只允许新建章节和调整章名。' };
    if (
      name === 'update_project' &&
      !policy.flexible &&
      (Object.keys(args).some((key) => !policy.fields?.some((field) => key === field)) ||
        (!policy.styleDescription && args.artStyle && 'description' in args.artStyle))
    )
      return { ok: false, summary: '只修改用户点名的作品设置字段，省略未要求的简介或画风描述。' };
    if (name === 'edit_story_design') {
      if (
        !policy.flexible &&
        ((policy.mode !== 'design' && !policy.designTargets?.length) ||
          !(
            designWriteTargets(policy).some(
              (target) => args.target && sameTarget(target, args.target),
            ) ||
            (args.target?.stage === 'chapter' && allowsChapterDesign(policy))
          ))
      )
        return { ok: false, summary: '该文档不在本轮指定的保存范围内。' };
      if (
        args.target.stage === 'outline' &&
        typeof args.text === 'string' &&
        args.text.trim() &&
        policy.fields?.some((field) => !settingsApplied.has(field))
      )
        return { ok: false, summary: '请先完成本轮声明的全局项目设置，再写入大纲。' };
      if (args.action === 'confirm' || args.confirmed === true) {
        if (policy.flexible) return;
        if (!policy.canConfirm)
          return { ok: false, summary: '本轮只写入草稿，保存时省略 confirmed。' };
        const selected = designConfirmations.find(({ target }) => sameTarget(target, args.target));
        if (!selected)
          return { ok: false, summary: '该文档还没有可确认的指定正文。可先读取相关讨论稿并保存。' };
        if (args.confirmed === true && args.text?.trim() !== selected.text.trim())
          return { ok: false, summary: '确认时使用 action=confirm，系统会沿用已选正文。' };
      }
    }
  } catch {
    // Let the tool schema report malformed input.
  }
}
