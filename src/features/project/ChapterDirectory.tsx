import { BookOpen } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { Chapter } from '../../../packages/domain/schema';

type ChapterNavigation = {
  chapters: Chapter[];
  chapterId: string;
  onSelect(id: string): void;
};

export function ChapterDirectory({
  chapters,
  chapterId,
  onSelect,
  status,
}: ChapterNavigation & { status?(chapter: Chapter): ReactNode }) {
  return (
    <nav className="story-design-nav" aria-label="章节目录">
      <div className="story-design-chapters">
        <h2>
          章节 <span>{chapters.length}</span>
        </h2>
        {chapters.map((chapter) => (
          <button
            key={chapter.id}
            type="button"
            className="story-design-nav-item"
            aria-current={chapterId === chapter.id ? 'page' : undefined}
            onClick={() => onSelect(chapter.id)}
          >
            <BookOpen size={17} aria-hidden="true" />
            <span className="story-design-nav-title" title={chapter.title}>
              {chapter.title}
            </span>
            {status?.(chapter)}
          </button>
        ))}
      </div>
    </nav>
  );
}

export function ChapterSelect({
  chapters,
  chapterId,
  onSelect,
  label,
}: ChapterNavigation & { label: string }) {
  return (
    <select
      className="story-design-scope"
      aria-label={label}
      value={chapterId}
      onChange={(event) => onSelect(event.target.value)}
    >
      {chapters.map(({ id, title }) => (
        <option key={id} value={id}>
          {title}
        </option>
      ))}
    </select>
  );
}
