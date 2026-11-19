import { z } from 'zod';
import {
  designStatus,
  designTargetSchema,
  designText,
  readDesign,
  readScriptScene,
  sceneKeySchema,
  updateDesign,
} from '../../domain/story-design';
import type { ToolRegistry } from './registry';
import { discussionDesignText, sameTarget } from '../creative-state';

export function registerStoryDesignTools(registry: ToolRegistry) {
  registry.register({
    name: 'read_story_design',
    label: '读取剧情大纲',
    group: 'design',
    mode: 'read',
    description:
      '读取项目简报、全剧大纲或指定章节正文。先用上下文中已载入的正文及本轮写入回执。target.stage 支持 brief、outline 或 chapter，chapter 需真实 chapterId。source=discussion 读取同范围最近讨论稿。查询工程中的单独场次可传 sceneKey，只用于 chapter，分页基于该场次正文。默认每页 8000 字符，limit 可设 1–12000。只按 nextOffset 补缺页；为 null 时结束，同一版本无需再读。',
    schema: z.strictObject({
      target: designTargetSchema,
      sceneKey: sceneKeySchema.optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(12000).default(8000),
      source: z.enum(['project', 'discussion']).default('project'),
    }),
    execute: (
      { project, creativeDraft, readPageCharacters },
      { target, sceneKey, offset, limit, source },
    ) => {
      if (sceneKey && (target.stage !== 'chapter' || source !== 'project'))
        throw new Error('sceneKey 仅用于读取工程章节剧本。');
      const scene =
        sceneKey && target.stage === 'chapter'
          ? readScriptScene(project, target.chapterId, sceneKey)
          : undefined;
      const entry =
        source === 'project'
          ? readDesign(project, target)
          : { text: discussionDesignText(creativeDraft, target), version: undefined };
      const text = scene ? (scene.status === 'linked' ? scene.text : '') : (entry?.text ?? '');
      const status =
        source === 'project' ? designStatus(project, target) : text ? 'draft' : 'missing';
      const metadata = {
        target,
        ...(scene && { sceneKey, scriptSceneStatus: scene.status }),
        source,
        status,
        version: entry?.version,
        offset,
        total: text.length,
      };
      let end = Math.min(text.length, offset + limit);
      if (readPageCharacters !== undefined) {
        const available = Math.max(2, readPageCharacters - JSON.stringify(metadata).length - 160);
        // Use the serialized size so dialogue with quotes and line breaks also fits.
        let left = Math.min(end, offset);
        let right = end;
        while (left < right) {
          const middle = Math.ceil((left + right) / 2);
          if (JSON.stringify(text.slice(offset, middle)).length <= available) left = middle;
          else right = middle - 1;
        }
        end = left;
      }
      if (end < text.length && end > offset && /[\uD800-\uDBFF]/.test(text[end - 1]))
        end += end === offset + 1 ? 1 : -1;
      return {
        ok: true,
        summary:
          scene?.status === 'duplicate'
            ? '剧本场次编号重复'
            : scene?.status === 'missing'
              ? '找不到剧本场次'
              : text
                ? '读取文本设计'
                : '此处尚无文本设计',
        data: {
          ...metadata,
          text: text.slice(offset, end),
          total: text.length,
          nextOffset: end < text.length ? end : null,
          truncated: end < text.length,
        },
      };
    },
  });
  registry.register({
    name: 'edit_story_design',
    label: '保存剧情大纲',
    group: 'design',
    mode: 'write',
    description:
      '保存剧情大纲标签中的作者文本。章节情节剧本按场次写情节、分支与后果。蓝图后的节点演出正文使用 edit_screenplay。保存草稿传 target 和完整 text，空正文清空条目。确认现有版本传 action=confirm 和 target。',
    schema: z.union([
      z.strictObject({
        target: designTargetSchema,
        text: designText,
        confirmed: z.boolean().default(false),
      }),
      z.strictObject({ action: z.literal('confirm'), target: designTargetSchema }),
    ]),
    execute: ({ project, designConfirmations }, args) => {
      if ('action' in args) {
        const selected = designConfirmations?.find(({ target }) => sameTarget(target, args.target));
        if (!selected) throw new Error('没有待确认的指定版本。');
        updateDesign(project, args.target, selected.text, true);
        return { ok: true, summary: '已确认文本设计' };
      }
      updateDesign(project, args.target, args.text, args.confirmed);
      return { ok: true, summary: args.confirmed ? '已确认文本设计' : '已更新文本设计' };
    },
  });
}
