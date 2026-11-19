import { useId, useState } from 'react';
import { storyboardPagesSchema, type Scene } from '../../packages/domain/schema';

type Pages = NonNullable<Scene['storyboardPages']>;
const pageSchema = storyboardPagesSchema.element;

export function StoryboardPageFields({
  pages,
  index,
  showDuration = true,
  onChange,
}: {
  pages: Pages;
  index: number;
  showDuration?: boolean;
  onChange: (pages: Pages) => string | void;
}) {
  const page = pages[index];
  const textId = useId();
  const [error, setError] = useState('');
  const apply = (patch: Partial<Pages[number]>, errorMessage: string) => {
    const parsed = pageSchema.safeParse({ ...page, ...patch });
    if (!parsed.success) {
      setError(errorMessage);
      return page;
    }
    if (parsed.data.text === page.text && parsed.data.durationMs === page.durationMs) {
      setError('');
      return page;
    }
    const result = onChange(pages.map((entry, i) => (i === index ? parsed.data : entry)));
    setError(result ?? '');
    return result ? page : parsed.data;
  };
  return (
    <div className="storyboard-page-fields">
      <div className="storyboard-page-heading">
        <label className="field-label" htmlFor={textId}>
          第 {index + 1} 页正文
        </label>
        {showDuration && (
          <label className="storyboard-page-duration">
            <input
              key={page.durationMs}
              aria-label={`第 ${index + 1} 页停留时长（秒）`}
              type="number"
              min={1}
              max={60}
              step={0.1}
              defaultValue={page.durationMs / 1000}
              onBlur={(event) => {
                const input = event.currentTarget;
                const durationMs = Math.round(Number(input.value) * 1000);
                input.value = String(
                  apply({ durationMs }, '每页停留时长须在 1 至 60 秒之间。').durationMs / 1000,
                );
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
            <span aria-hidden>秒</span>
          </label>
        )}
      </div>
      <textarea
        id={textId}
        key={page.text}
        rows={3}
        maxLength={160}
        defaultValue={page.text}
        onBlur={(event) => {
          const input = event.currentTarget;
          input.value = apply({ text: input.value }, '每页需要填写正文，最多 160 字。').text;
        }}
      />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
