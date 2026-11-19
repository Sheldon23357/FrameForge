import type { Scene } from '../../../packages/domain/schema';
import { storyboardAt } from '../../../packages/domain/timeline';

export function Storyboard({
  pages,
  positionMs,
  overlay = false,
}: {
  pages: NonNullable<Scene['storyboardPages']>;
  positionMs: number;
  overlay?: boolean;
}) {
  const index = storyboardAt(pages, positionMs);
  if (index === -1) return null;
  return (
    <div className={overlay ? 'player-storyboard player-storyboard-overlay' : 'player-storyboard'}>
      <div className="player-storyboard-copy">
        <p>{pages[index].text}</p>
        {pages.length > 1 && (
          <small>
            {index + 1} / {pages.length}
          </small>
        )}
      </div>
    </div>
  );
}
