import type { Project } from '../domain/schema';
import { activeStoryboard } from '../domain/timeline';

export function endingStructureErrors(project: Project) {
  const endings = new Map(
    project.scenes.filter(({ kind }) => kind === 'ending').map((scene) => [scene.id, scene]),
  );
  const media = new Set(project.assets.filter(({ type }) => type !== 'audio').map(({ id }) => id));
  const playable = new Set<string>();
  const errors = new Map<string, string>();
  for (const chapter of project.chapters) {
    const ending = endings.get(chapter.startNodeId);
    if (ending)
      errors.set(
        `chapter:${chapter.id}:${ending.id}`,
        `「${chapter.title}」的起点须先播放剧情视频，再进入「${ending.title}」总结。`,
      );
  }
  for (const source of project.scenes) {
    const target = endings.get(source.nextId);
    if (
      target &&
      source.kind === 'video' &&
      !source.choices.length &&
      ((source.assetId && media.has(source.assetId)) ||
        activeStoryboard(source) ||
        source.timeline?.videoClips.length ||
        source.timeline?.stillClips?.length)
    ) {
      playable.add(target.id);
    } else if (target) {
      errors.set(
        `${source.id}:next:${target.id}`,
        `「${source.title}」(${source.id}) 到「${target.title}」(${target.id}) 需要先播放一段独立结局剧情。`,
      );
    }
    for (const choice of source.choices) {
      const ending = endings.get(choice.targetId);
      if (ending)
        errors.set(
          `${source.id}:${choice.id}:${ending.id}`,
          `「${source.title}」(${source.id}) 的选项「${choice.label}」须先跳到独立结局剧情视频，再进入「${ending.title}」(${ending.id}) 总结。`,
        );
    }
  }
  for (const ending of endings.values()) {
    if (!playable.has(ending.id))
      errors.set(
        `ending:${ending.id}`,
        `「${ending.title}」(${ending.id}) 缺少播放完成后自动接入的结局剧情视频。请绑定素材或填写剧情文字，结局节点只写总结。`,
      );
  }
  return errors;
}
