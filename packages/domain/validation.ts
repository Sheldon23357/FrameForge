import { choiceQuestionMaxLength, Condition, Effect, Project, storyStartId } from './schema';
import {
  activeStoryboard,
  dialogueEndMs,
  nodeDuration,
  playerTextPlayback,
  timelineIssues,
} from './timeline';
import { worldSettingIssue } from './world-settings';
import { productionShotIssue } from './production-shots';
import { automaticBranchLimit, inspectAutomaticBranches, reachableStoryNodes } from './story-graph';
export type Diagnostic = { severity: 'error' | 'warning'; message: string; nodeId?: string };
export function validateProject(p: Project): Diagnostic[] {
  const issues: Diagnostic[] = [];
  const report = (severity: Diagnostic['severity'], message: string, nodeId?: string) =>
    issues.push({ severity, message, nodeId });
  const scenes = new Map(p.scenes.map((s) => [s.id, s]));
  const chapters = new Map(p.chapters.map((c) => [c.id, c]));
  const variables = new Map(p.variables.map((v) => [v.id, v]));
  const items = new Set(p.items.map((i) => i.id));
  const assets = new Map(p.assets.map((a) => [a.id, a]));
  const settings = new Set(p.worldSettings?.map((entry) => entry.id));
  const allIds = [
    ...p.chapters.map((c) => c.id),
    ...p.scenes.map((s) => s.id),
    ...p.variables.map((v) => v.id),
    ...p.items.map((i) => i.id),
    ...(p.worldSettings ?? []).map((entry) => entry.id),
    ...(p.productionShots ?? []).map((shot) => shot.id),
    ...p.assets.map((a) => a.id),
    ...p.scenes.flatMap((s) => [...s.choices.map((c) => c.id), ...s.events.map((e) => e.id)]),
    ...p.scenes.flatMap((s) =>
      [...(s.timeline?.videoClips ?? []), ...(s.timeline?.audioClips ?? [])].map((c) => c.id),
    ),
  ];
  if (new Set(allIds).size !== allIds.length)
    report('error', '工程存在重复 ID，请重新导入或复制节点。');
  const screenplayNodes = new Set<string>();
  for (const { id } of p.screenplays ?? []) {
    if (screenplayNodes.has(id) || scenes.get(id)?.kind !== 'video')
      report('error', '剧本正文重复或未关联有效的演出节点。', id);
    screenplayNodes.add(id);
  }
  for (const setting of p.worldSettings ?? []) {
    const issue = worldSettingIssue(p, setting);
    if (issue) report('error', `设定「${setting.name}」：${issue}`);
  }
  const shotLabels = new Map<string, Set<string>>();
  for (const shot of p.productionShots ?? []) {
    const issue = productionShotIssue(shot, scenes, assets, settings);
    if (issue) report('error', `镜头「${shot.label}」：${issue}`, shot.nodeId);
    const labels = shotLabels.get(shot.nodeId) ?? new Set<string>();
    const label = shot.label.toLowerCase();
    if (labels.has(label)) report('error', `镜号「${shot.label}」重复。`, shot.nodeId);
    labels.add(label);
    shotLabels.set(shot.nodeId, labels);
  }
  if (!scenes.has(p.startNodeId)) report('error', '第一章尚未设置有效起点。');
  if (p.startNodeId !== storyStartId(p)) report('error', '游戏开场必须是第一章的起点。');
  if (!p.chapters.length) report('error', '作品至少需要一个章节。');
  const chapterNames = new Set<string>();
  for (const chapter of p.chapters) {
    if (!chapter.title.trim()) report('error', '章节名称不能为空。');
    if (chapterNames.has(chapter.title.trim()))
      report('error', `存在同名章节「${chapter.title}」。`);
    chapterNames.add(chapter.title.trim());
    const members = p.scenes.filter((s) => s.chapterId === chapter.id);
    if (
      members.length &&
      (!chapter.startNodeId || scenes.get(chapter.startNodeId)?.chapterId !== chapter.id)
    )
      report('error', `章节「${chapter.title}」未设置有效的本章入口。`);
    if (!members.length && chapter.startNodeId)
      report('error', `空章节「${chapter.title}」引用了无效入口。`);
  }
  for (const v of p.variables) {
    if (typeof v.initial !== v.type) report('error', `属性「${v.name}」的初始值类型不匹配。`);
    if (v.min !== undefined && v.max !== undefined && v.min > v.max)
      report('error', `属性「${v.name}」最小值大于最大值。`);
    if (
      typeof v.initial === 'number' &&
      ((v.min !== undefined && v.initial < v.min) || (v.max !== undefined && v.initial > v.max))
    )
      report('error', `属性「${v.name}」初始值超出范围。`);
  }
  if (p.saveMigration) {
    const ids = new Set<string>();
    for (const entry of p.saveMigration.addVariables) {
      const definition = variables.get(entry.id);
      if (
        !definition ||
        ids.has(entry.id) ||
        (entry.sources.length && definition.type !== 'number')
      )
        report('error', '存档迁移引用了无效或重复的新增属性。');
      if (entry.sources.some((source) => !items.has(source.itemId)))
        report('error', '存档迁移引用了不存在的线索道具。');
      ids.add(entry.id);
    }
  }
  const checkCondition = (c: Condition, node: string) => {
    if (c.kind === 'all' || c.kind === 'any') {
      c.children.forEach((x) => checkCondition(x, node));
      if (c.kind === 'any' && !c.children.length)
        report('warning', '空的「任一满足」条件永远不通过。', node);
    } else if (c.kind === 'not') checkCondition(c.child, node);
    else if (c.kind === 'variable') {
      const v = variables.get(c.variableId);
      if (!v) report('error', '条件引用了不存在的属性。', node);
      else if (typeof c.value !== v.type || (!['eq', 'ne'].includes(c.op) && v.type !== 'number'))
        report('error', `「${v.name}」的条件类型或比较方式不正确。`, node);
    } else if (c.kind === 'item' && !items.has(c.itemId))
      report('error', '条件引用了不存在的道具。', node);
    else if (c.kind === 'visited' && !scenes.has(c.nodeId))
      report('error', '访问条件引用了不存在的节点。', node);
  };
  const checkEffects = (effects: Effect[], node: string) =>
    effects.forEach((e) => {
      if (e.kind === 'setVariable' || e.kind === 'addVariable') {
        const v = variables.get(e.variableId);
        if (!v) report('error', '效果引用了不存在的属性。', node);
        else if ((e.kind === 'addVariable' && v.type !== 'number') || typeof e.value !== v.type)
          report('error', `「${v.name}」的效果值类型不正确。`, node);
      } else if (e.kind === 'showMessage') {
        if (!e.text.trim()) report('error', '剧情提示内容不能为空。', node);
      } else if (!items.has(e.itemId)) report('error', '效果引用了不存在的道具。', node);
    });
  for (const s of p.scenes) {
    if (s.settingIds?.some((id) => !settings.has(id)))
      report('error', '节点关联了不存在的设定。', s.id);
    if (!chapters.has(s.chapterId)) report('error', '节点所属章节不存在。', s.id);
    if (!s.title.trim()) report('warning', '节点还没有名称。', s.id);
    const asset = s.assetId ? assets.get(s.assetId) : undefined;
    if (s.assetId && !asset) report('error', '节点引用的素材已丢失。', s.id);
    const storyboard = activeStoryboard(s);
    if ((s.storyboardPages?.length || s.storyboardOverlay) && s.kind !== 'video')
      report('error', '只有视频节点可以使用故事板。', s.id);
    if (
      s.kind === 'video' &&
      !s.assetId &&
      !s.timeline?.stillAssetId &&
      !s.timeline?.stillClips?.length &&
      !s.timeline?.videoClips.length &&
      !storyboard
    )
      report('warning', '视频节点未绑定素材，将使用占位场景试玩。', s.id);
    if (asset?.type === 'audio') report('error', '视频节点不能绑定纯音频素材。', s.id);
    const end = s.trimEndMs ?? (asset?.durationMs || s.durationMs);
    if (!s.timeline && !storyboard && s.trimStartMs >= end)
      report('error', '入点必须早于出点。', s.id);
    timelineIssues(p, s).forEach((message) => report('error', message, s.id));
    const duration = nodeDuration(p, s);
    if (s.kind === 'video' && playerTextPlayback(p, s).choiceBeforeTextEnd)
      report('warning', '选项会在最后一页剧情文字结束前出现。', s.id);
    if ((s.choiceQuestion?.length ?? 0) > choiceQuestionMaxLength)
      report('error', `互动问题最多 ${choiceQuestionMaxLength} 个字符。`, s.id);
    if (s.kind !== 'video' && s.choiceQuestion?.trim())
      report('error', '只有视频节点可以设置互动问题。', s.id);
    if (s.choices.length && Math.min(s.choicesAtMs ?? duration, duration) < dialogueEndMs(s))
      report('warning', '选项会在配音结束前出现。', s.id);
    if (s.choicesAtMs !== null && s.choicesAtMs > duration)
      report('error', '选项出现时间超出了片段长度。', s.id);
    if (s.nextId && !scenes.has(s.nextId)) report('error', '自动跳转目标不存在。', s.id);
    if (s.kind === 'video' && !s.nextId && !s.choices.length)
      report('warning', '片段结束后没有出口，试玩会停留在此处。', s.id);
    if (
      s.kind === 'branch' &&
      !s.choices.some((c) => c.condition.kind === 'all' && !c.condition.children.length)
    )
      report('error', '条件分支需要一个无条件的兜底出口。', s.id);
    if (s.kind === 'branch') {
      const fallback = s.choices.findIndex(
        (c) => c.condition.kind === 'all' && !c.condition.children.length,
      );
      if (fallback >= 0 && fallback < s.choices.length - 1)
        report('warning', '兜底出口之后的分支不会执行，请调整顺序。', s.id);
    }
    for (const c of s.choices) {
      if (!c.targetId || !scenes.has(c.targetId))
        report('error', `选项「${c.label}」还没有有效的跳转目标。`, s.id);
      if (!c.label.trim()) report('error', '选项文案不能为空。', s.id);
      checkCondition(c.condition, s.id);
    }
    for (const e of s.events) {
      checkEffects(e.effects, s.id);
      if (e.trigger === 'complete' && s.kind !== 'video')
        report('error', `事件「${e.name}」需要放在视频节点上。`, s.id);
      if (e.trigger === 'time' && e.atMs > duration)
        report('warning', `事件「${e.name}」的触发时间超出了片段长度。`, s.id);
    }
  }
  const visited = reachableStoryNodes(scenes, [p.startNodeId]);
  p.scenes
    .filter((s) => !visited.has(s.id))
    .forEach((s) => report('warning', '此节点无法从故事起点连通。', s.id));
  const { cyclic, tooLong } = inspectAutomaticBranches(scenes);
  if (cyclic) report('error', '存在仅由自动条件分支构成的循环，请加入视频或等待节点。');
  if (tooLong)
    report(
      'error',
      `连续自动条件分支超过 ${automaticBranchLimit} 个，请加入视频或等待节点。`,
      tooLong,
    );
  return issues;
}
