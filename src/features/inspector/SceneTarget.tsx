import { type Project, type Scene, sceneLabel } from '../../../packages/domain/schema';
import { useEditor } from '../../store/editor';
import { ArrowUpRight } from '@phosphor-icons/react';

export function SceneOptions({ project: p }: { project: Project }) {
  return p.chapters.map((chapter) => (
    <optgroup key={chapter.id} label={chapter.title}>
      {p.scenes
        .filter((s) => s.chapterId === chapter.id)
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
            {chapter.startNodeId === s.id ? ' · 章节起点' : ''}
          </option>
        ))}
    </optgroup>
  ));
}

export function CrossChapterTarget({
  project: p,
  scene,
  targetId,
}: {
  project: Project;
  scene: Scene;
  targetId: string;
}) {
  const target = p.scenes.find((s) => s.id === targetId);
  if (!target || target.chapterId === scene.chapterId) return null;
  return (
    <button
      className="cross-chapter-target"
      onClick={() => useEditor.getState().focusScene(targetId)}
      title={sceneLabel(p, targetId)}
    >
      <ArrowUpRight size={13} />
      <span>跨章 → {sceneLabel(p, targetId)}</span>
    </button>
  );
}
