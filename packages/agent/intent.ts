import { z } from 'zod';
import { creativePolicySchema } from './creative-state';
import type { Project } from '../domain/schema';
import type { AgentCheckpoint } from './types';

const policySchema = creativePolicySchema.strict();
export const creativeIntentSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), policy: policySchema }),
  z.strictObject({ action: z.literal('resume') }),
  z.strictObject({ action: z.literal('amend'), policy: policySchema }),
]);
export type CreativeIntent = z.infer<typeof creativeIntentSchema>;

export const scopeInstructions = `普通编辑直接调用注册工具。只处理用户本轮明确交付的内容和完成它所需的步骤。只问进度或提出讨论时，可以查证后直接回复。简短答复「是的」「可以」只确认上一条回复中明确提出的动作、章节和范围。完成指定交付后结束本轮，简述实际写入结果。
写大纲交付大纲文档。章节情节剧本写场次、路线、任务分歧、选择后果和条件，用情节概括角色要表达的内容。蓝图的节点内容写从哪来、已知与持有、这一段新增什么、往哪去，并落实连线、状态及必要的试玩文字。蓝图之后用 edit_screenplay 保存节点完整动作、逐句对白、独白和声音。按正文拆镜时先用 read_screenplay 读完整正文并核对真实前后节点，制作描述写进镜头卡，玩家文案写进剧情文字。单独要求修改某项、生成素材或入轨时按对应范围执行。文档确认需要用户明确要求。
用户要求把大纲拆成章节正文时，用 edit_chapter 的 designText 逐章保存。新章同一次调用传章名和正文，已有章节用真实 ID 更新。续跑沿用已写入正文，接着写范围内缺失的章节。用户给出目标章数时，只补到指定数量。用户已把创作决定交给你时，按指定目标推进。
继续已有检查点时用 set_task_scope 的 resume。用户明确调整待办时用 amend。需要原样保存讨论稿或复制完整分章正文时，可用 start 配合 saveDiscussion 或 saveChapterStructure。仅有章节表格时可按表格扩写。
项目画幅使用横屏 16:9 或竖屏 9:16。用户明确要求写入立项参数或维护项目制作规格时，按 frameforge-project-setup 读取并主动补齐有依据的项目参数，用 update_project 保存故事背景、观感偏好、受众、画幅、作品画风和风格补充描述，沿用已经确定的参数。写分镜卡时保存画面提示词。视频文字按用户指定片段编写跨帧连续动作，在对话中交付。直接在对话交付新图像或视频提示词时，将工程的 atmosphereTone 作为独立段落加入一次。用户明确要求实际生成或导入时再调用相应媒体工具。`;

export function resolveCreativeIntent(
  intent: CreativeIntent,
  project: Project,
  saved?: AgentCheckpoint,
) {
  if (intent.action !== 'start' && !saved) throw new Error('没有可继续的创作草稿。');
  const policy = intent.action === 'resume' ? saved?.creativePolicy : intent.policy;
  if (!policy) throw new Error('旧草稿没有执行范围，请说明要继续的目标。');
  const draftChapters = intent.action !== 'start' ? saved?.draft.chapters : undefined;
  const invalidTarget = [policy.target, ...(policy.designTargets ?? [])].some(
    (target) =>
      target.stage === 'chapter' &&
      !project.chapters.some((chapter) => chapter.id === target.chapterId) &&
      !draftChapters?.some((chapter) => chapter.id === target.chapterId),
  );
  const savesExisting = policy.saveDiscussion || policy.saveChapterStructure;
  if (
    invalidTarget ||
    (intent.action === 'amend' && policy.mode === 'discuss') ||
    (policy.mode === 'chapter' && policy.target.stage !== 'chapter') ||
    (policy.mode === 'settings' && !policy.fields?.length) ||
    (savesExisting &&
      (intent.action === 'amend' ||
        policy.mode !== 'design' ||
        policy.target.stage !== 'outline' ||
        policy.designTargets?.length ||
        (policy.saveDiscussion && policy.saveChapterStructure)))
  )
    throw new Error('创作意图包含无效目标或写入范围，未执行编辑。');
  return policy;
}
