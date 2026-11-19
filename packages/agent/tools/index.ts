import { ToolRegistry } from './registry';
import { registerStoryTools, storyOverviewCharacters } from './story';
import { registerProjectTools } from './project';
import { registerProjectVersionTools } from './project-versions';
import { registerHistoryTools } from './history';
import { registerTimelineTools } from './timeline';
import { registerChoiceImpactTool } from './choice-impact';
import { registerWorkflowTools } from './workflow';
import { registerBatchReadTool } from './batch-read';
import { registerWorldSettingTools } from './world-settings';
import { registerSkillTool } from './skills';
import { registerProductionShotTools } from './production-shots';
import { registerMediaTools } from './media';
import { registerStoryDesignTools } from './story-design';
import { registerPlaybackTool } from './playback';
import { registerScreenplayTools } from './screenplay';
export function createEditorTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registerStoryTools(registry);
  registerProjectTools(registry);
  registerProjectVersionTools(registry);
  registerHistoryTools(registry);
  registerTimelineTools(registry);
  registerChoiceImpactTool(registry);
  registerWorkflowTools(registry);
  registerWorldSettingTools(registry);
  registerProductionShotTools(registry);
  registerMediaTools(registry);
  registerStoryDesignTools(registry);
  registerPlaybackTool(registry);
  registerScreenplayTools(registry);
  registry.combine(
    {
      name: 'edit_scene',
      label: '编辑剧情节点',
      description:
        'create 和 insert 必填节点内容 notes。新写或改写 notes 时分四项，从哪来、已知与持有、这一段新增什么、往哪去。供后续制作按所属章与前后节点定位剧情。插入过场优先用 insert，另传 fromId、title、storyboardPages，一次插入并保留原自动出口。action 与其他参数同层。batch 用 operations 一次处理 1–8 项 insert、create、update、connect 或 move，按顺序返回各项结果与真实节点 ID。批量创建后，用返回的 ID 批量连线。玩家可点击的选项放在 kind=video 节点，其整组选项上方的互动问题使用 choiceQuestion，update 用 patch.choiceQuestion，传空字符串清除。kind=branch 按条件自动跳转。无素材的 video 节点填写 storyboardPages，蓝图阶段可先给玩家可读的试玩占位文字，节点制作再按分镜和揭示时点定稿。每页填写 text，durationMs 可选。update 用 patch.notes 更新节点内容，patch.storyboardPages 更新剧情文字，patch.storyboardOverlay 开关素材上叠字。connect 设置无选项节点的自动跳转，move 批量移章。',
      category: 'story',
    },
    {
      create: 'create_scene',
      insert: 'insert_story_scene',
      update: 'update_scene',
      connect: 'connect_scenes',
      move: 'move_scenes',
    },
    { flat: true, batch: true, minBatchSize: 1 },
  );
  registry.combine(
    {
      name: 'read_story',
      label: '查询剧情',
      maxResultCharacters: storyOverviewCharacters,
      description:
        'playback 按实际播放路线一次查目标及相邻节点的正文、分镜、对白和三条声画轨，优先用于局部衔接检查；overview 通读整章或全剧正文与出边；list 找节点（结局用 kind=ending）；topology 查连线。用 read 的 section=notes 读取完整节点内容，timeline 查指定轨道，shots 找镜号，shot 查指定镜头与提示词。按返回的续页位置取剩余内容。',
      category: 'story',
    },
    {
      list: 'list_scenes',
      read: 'read_scene',
      topology: 'read_story_topology',
      overview: 'read_story_overview',
      playback: 'read_playback',
      timeline: 'read_timeline',
      shots: 'list_production_shots',
      shot: 'read_production_shot',
    },
    { flat: true },
  );
  registry.combine(
    {
      name: 'check_story',
      label: '检查工程与路线',
      description:
        'validate 检查工程结构；explore 检查可点击分支和可达结局，默认从全作起点，可传真实 nodeId 指定入口；simulate 按真实玩家选项 ID、等待步骤或指定初始属性和库存验证单条路线，detail=pacing 分页返回净播放时长、分章小计、逐节点镜头计划与玩家文字播放状态；inspect_choice 查选项跳转、后续节点事件和下游引用。批量分析先用 detail=summary 或 section=summary。',
      category: 'analysis',
    },
    {
      validate: 'validate_project',
      explore: 'explore_routes',
      simulate: 'simulate_route',
      inspect_choice: 'inspect_choice_impact',
    },
    { flat: true },
  );
  registry.combine(
    {
      name: 'open_story_view',
      label: '定位节点或启动试玩',
      description: 'focus 在蓝图选中指定节点；preview 从指定节点或第一章起点启动试玩。',
      category: 'analysis',
    },
    { focus: 'focus_scene', preview: 'preview_story' },
    { flat: true },
  );
  registry.combine(
    {
      name: 'read_conversation',
      label: '检索与读取对话记录',
      description:
        'search 按关键词查历史消息并返回 turnId；read 按 turnId 分页读取原消息、工具调用和结果。',
      category: 'context',
    },
    { search: 'search_history', read: 'read_history_turn' },
    { flat: true },
  );
  registerBatchReadTool(registry);
  registerSkillTool(registry);
  return registry;
}
export { ToolRegistry } from './registry';
