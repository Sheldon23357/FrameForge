import { useState } from 'react';
import { snapStoryTime, storyTimeStepMs } from '../../packages/domain/story-time';
import { Field } from './ui';

export function StoryTimeInput({
  label,
  value,
  durationMs,
  onChange,
  nullable = false,
}: {
  label: string;
  value: number | null;
  durationMs: number;
  onChange: (ms: number | null) => void;
  nullable?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = value === null ? '' : (snapStoryTime(value, durationMs) / 1000).toFixed(1);
  return (
    <Field label={label}>
      <input
        type="number"
        min="0"
        step={storyTimeStepMs / 1000}
        value={draft ?? display}
        placeholder={nullable ? '片尾' : undefined}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={(e) => {
          const { validity, valueAsNumber } = e.currentTarget;
          if (draft !== null && !validity.badInput) {
            const ms = valueAsNumber * 1000;
            if (draft === '' && nullable && value !== null) onChange(null);
            else if (Number.isFinite(ms) && ms >= 0) {
              const snapped = snapStoryTime(ms, durationMs);
              if (snapped !== value) onChange(snapped);
            }
          }
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </Field>
  );
}
