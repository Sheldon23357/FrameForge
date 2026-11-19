import { z } from 'zod';
import type { Project } from '../domain/schema';
import { skillNameSchema } from './skills';

const ordinal = z.number().int().min(1).max(10_000);
const chapterSelection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('active') }),
  z.strictObject({ kind: z.literal('project') }),
  z.strictObject({ kind: z.literal('ordinals'), values: z.array(ordinal).min(1).max(1000) }),
  z.strictObject({ kind: z.literal('range'), from: ordinal, through: ordinal.optional() }),
]);

const designSchema = z.strictObject({
  brief: z.boolean().default(false),
  outline: z.boolean().default(false),
  chapter: z.boolean().default(false),
  chapters: chapterSelection.optional(),
  outlineChapterCount: ordinal.optional(),
  canEditSettings: z.boolean().default(false),
  canEditWorld: z.boolean().default(false),
  canEditGameData: z.boolean().default(false),
});
const storyScope = z.enum(['active', 'project', 'selected']);
export const materialOptionsSchema = z.strictObject({
  generate: z.boolean().default(false),
  timeline: z.boolean().default(false),
  overlay: z.boolean().default(false),
  replace: z.boolean().optional(),
  shotIds: z.array(z.string().min(1)).min(1).max(10000).optional(),
});
export const requestPlanSchema = z.strictObject({
  kind: z.enum(['execute', 'read', 'status', 'resume', 'amend']),
  resumeTaskId: z.uuid().optional(),
  design: designSchema.optional(),
  blueprint: z
    .strictObject({
      build: z.boolean(),
      scope: storyScope.default('active'),
      ordinal: ordinal.optional(),
      preview: z.boolean().default(false),
      minimumNewNodes: ordinal.optional(),
    })
    .optional(),
  production: z
    .strictObject({
      scope: storyScope.default('selected'),
      ordinal: ordinal.optional(),
      fromScreenplay: z.boolean().optional(),
    })
    .optional(),
  screenplay: z
    .strictObject({ scope: storyScope.default('active'), ordinal: ordinal.optional() })
    .optional(),
  materials: materialOptionsSchema
    .extend({ scope: storyScope.default('active'), ordinal: ordinal.optional() })
    .refine(({ generate, timeline, replace }) => (generate || timeline) && (!replace || generate))
    .optional(),
  canConfirm: z.boolean().default(false),
  saveDiscussion: z.boolean().default(false),
  expandStory: z.boolean().default(false),
  externalActions: z
    .array(z.enum(['import', 'image', 'audio', 'retry']))
    .max(4)
    .optional(),
  skills: z.array(skillNameSchema).max(8).default([]),
});
export type RequestPlan = z.infer<typeof requestPlanSchema>;

export function resolveRequestChapter(
  plan: RequestPlan,
  request: string,
  chapters: Project['chapters'],
): RequestPlan {
  if (plan.kind !== 'execute' && plan.kind !== 'amend') return plan;
  const opening = request.split(/[。！？\n]/u, 1)[0];
  if (/当前(?:画布|章节|章)|参考|参照|对照/u.test(opening)) return plan;
  const references = new Set(
    [...opening.matchAll(/[（(]\s*(chapter_[\w-]+)\s*[）)]/gu)].map(([, id]) => id),
  );
  if (references.size !== 1) return plan;
  const ordinal = chapters.findIndex(({ id }) => references.has(id)) + 1;
  if (!ordinal) return plan;
  const scoped = <T extends { scope: string; ordinal?: number }>(stage: T | undefined) =>
    stage?.scope === 'active' && stage.ordinal === undefined ? { ...stage, ordinal } : stage;
  return {
    ...plan,
    blueprint: scoped(plan.blueprint),
    screenplay: scoped(plan.screenplay),
    production: scoped(plan.production),
    materials: scoped(plan.materials),
  };
}

export const requestPlanInstructions = `根据本轮请求的完整语义、对话上下文和工程范围理解本轮要做什么。只返回一个 JSON 对象，直接使用以下字段。不要创作正文、执行工具或输出解释。
- kind 必填。execute 是本轮要求执行交付，read 是查询、分析、讨论或只在对话交付，status 是只问工程或中断任务的总体进度，resume 是按原范围恢复已有检查点，amend 是带新任务范围恢复已有检查点。单独的同意或否定要结合上一轮实际提议，只处理用户确实接受的具体事项。取消、拒绝、限制条件和“先做甲，再做乙”应按整句解释。对话和检查点是理解指代的材料，不能扩大本轮授权。
- 从创意开始时按当前这一步规划。用户只描述题材、风格、故事设想，或说“我想创建一个奥本海默题材的悬疑故事”，用 {"kind":"read","skills":["frameforge-project-setup"]}，在对话中了解主角、开场或核心悬念。用户回答创作问题、补充设定或接受一个点子时继续讨论。项目名、已选技能、预设和常规制作顺序都不能授权写简报、大纲、章节或剧本。
- 每个创作阶段只安排用户这轮点名要求交付的内容。要求整理简报只处理简报；要求生成大纲只处理大纲；要求写某一章只处理指定章节。一个阶段完成后交还给用户。只有用户明确要求连做多个阶段或接受上一轮具体的跨阶段提议时才合并任务。仅请求聊一聊、给建议或看示例时在对话中交付。
- resume 或 amend 只有用户指明要继续某个较早的待办时才填写 resumeTaskId，从 pendingTasks 找到该任务的实际 ID。省略时继续最近的待办。
- 本轮用章名、章序或真实 ID 明确指定目标章节时，按 chapters 目录找到 ordinal，填写到相应阶段。只有用户没有指定目标、确实指当前画布章节时，才用不带 ordinal 的 active。阅读参考、前后衔接章节与写入目标可能不同。
- design 只在需要直接写入或确认作者文档时提供。可用 brief、outline、chapter 指明简报、大纲和章节情节剧本，值为 true。chapters 指定章节范围，选择 {"kind":"active"}（当前章）、{"kind":"project"}（现有各章）、{"kind":"ordinals","values":[2,4]}（指定章）或 {"kind":"range","from":2,"through":6}（闭区间，未指定末章时可省略 through，写到大纲覆盖末章）。outlineChapterCount 表示大纲要求的总章数或总集数。直接修改作品设置、人物或场景设定、数值或道具时可声明 canEditSettings、canEditWorld、canEditGameData。搭蓝图所需的变量、道具和结算已属于 blueprint，无须在 design 重复声明。
- blueprint 只在明确要求修改剧情蓝图时提供。build=true 表示将章节情节剧本落实为节点内容、选项、连线、条件和结算，可用临时文字占位试玩；常规的节点、连线或玩家可见内容修改用 false。scope 用 active、project 或 selected，分别表示当前章、全工程或选中节点，可提供 ordinal 指定章序，preview 为 true 表示还要求启动试玩，minimumNewNodes 是用户明确要求的新建节点数。
- materials 用于按现有镜头生成静态分镜首帧（generate=true）和将首帧加入节点图片轨（timeline=true），两个动作按用户要求独立选择。用户明确要求重生成并替换已有首帧时，同时设 generate=true、replace=true；如果还要求原位替换时间线里的旧图，设 timeline=true。补缺时省略 replace。overlay=true 表示入轨后保留画面上的剧情文字。scope 和 ordinal 与 blueprint 相同；只处理明确指定的实际镜头时用 shotIds。只做首帧素材与入轨时省略 blueprint 和 production，续跑按现有镜头、图片绑定与时间线继续。其他素材或一般时间线编辑使用原有工具，不填 materials。
- creativeInput 提供已保存的项目创作默认值和本轮指定的 Skill。消息里明确说出的要求用于本轮创作。立项或统一项目制作规格时设置 design.canEditSettings=true，允许 setup Skill 维护故事背景、观感偏好、受众、画幅、作品画风及风格补充描述。如果同时要写项目简报，设置 design.brief=true。仅修改大纲、正文或定稿时按对应范围处理。首次生成或重排全剧大纲且消息未指定总章数时，可沿用旧工程中保存的 creativeInput.options.chapterCount。局部修订保留已有章数。
- screenplay 在要求编写、补写或修订「章节剧本」页中的演出正文（动作、逐句对白、独白、声音）时提供。scope 用 selected、active 或 project，可用 ordinal 指定章序。「分章节大纲」或只写章节情节、分支和后果属于 design.chapter。
- production 在明确要求同一批节点拆镜并编排正式玩家剧情文字时提供。scope 用 selected、active 或 project，可用 ordinal 指定章序。根据正文拆镜或新流程端到端制作时使用 fromScreenplay=true。写正文并拆镜时同时提供 screenplay 与 production，宿主依序执行章节剧本、蓝图、正文与分镜。旧工程的单独镜头调整、单独生成素材和入轨沿用对应工具范围。
- canConfirm 只在明确要求标为已确认或正式定稿时为 true。saveDiscussion 只在明确要求把既有对话里的大纲原样保存时为 true。expandStory 只在明确要求直接扩写工程里蓝图的叙事篇幅时为 true。
- externalActions 记录本轮明确授权的外部动作：import 是现在打开文件选择器，image 是实际生成图片，audio 是实际生成声音，retry 是明确要求重新发起之前已失败或结果未知的外部作业。只写提示词、只编排已有素材、取消和推迟操作都不授权对应动作。按工作流必须实际生成首帧时，materials.generate 已授权 image。普通续跑沿用原任务授权，明确重试才获得 retry。
- skills 是适用于交付的可用技能名称数组，按提供的说明和任务整体选取，允许多选。全局大纲拆成章节情节与路线用 frameforge-chapter-planning；将章节剧本落实为节点、连线和游戏规则用 frameforge-chapter-blueprint；完整演出正文用 frameforge-node-screenplay；拆镜与玩家文字编排用 frameforge-node-storyboard。静帧提示词用 frameforge-storyboard-prompts，连续视频提示词用 frameforge-video-prompts。已有静帧提示词，仅执行生成时无需重做分镜设计。
不适用的字段可以省略。对格式有疑问时至少返回必填 kind。示例格式：{"kind":"execute","design":{"chapter":true,"chapters":{"kind":"ordinals","values":[2]}},"skills":[]}`;
