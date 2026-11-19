import { Flag } from '@phosphor-icons/react';
import { type Project, type Scene } from '../../../packages/domain/schema';
import { useEditor } from '../../store/editor';

export function StartSettings({ project, scene }: { project: Project; scene: Scene }) {
  const isStart = project.chapters.find((c) => c.id === scene.chapterId)?.startNodeId === scene.id;
  return (
    <button
      className={`start-toggle ${isStart ? 'active' : ''}`}
      aria-pressed={isStart}
      onClick={() => useEditor.getState().setChapterEntry(scene.chapterId, scene.id)}
    >
      <Flag size={13} weight={isStart ? 'fill' : 'regular'} />
      {isStart ? '已设为起点' : '设为起点'}
    </button>
  );
}
