import { useId } from 'react';
import {
  creativeAudiences,
  creativeGenres,
  creativeTones,
  type CreativeOptions,
} from '../../../packages/domain/creative-options';
import { Field } from '../../components/ui';

function OptionSelect<T extends string>({
  label,
  values,
  value,
  change,
}: {
  label: string;
  values: readonly T[];
  value?: T;
  change(value?: T): void;
}) {
  return (
    <Field label={label}>
      <select
        value={value ?? ''}
        onChange={(event) => change((event.target.value || undefined) as T | undefined)}
      >
        <option value="">未设置</option>
        {value && !values.includes(value) && <option>{value}</option>}
        {values.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </Field>
  );
}

export function CreativeOptionsForm({
  options,
  change,
}: {
  options: CreativeOptions;
  change(options: CreativeOptions): void;
}) {
  const backgrounds = useId();
  const patch = (fields: Partial<CreativeOptions>) => change({ ...options, ...fields });
  return (
    <div className="project-creative-list">
      <Field label="故事背景">
        <input
          list={backgrounds}
          maxLength={60}
          placeholder="选择或自定义"
          value={options.genre ?? ''}
          onChange={(e) => patch({ genre: e.target.value || undefined })}
        />
        <datalist id={backgrounds}>
          {creativeGenres.map((genre) => (
            <option key={genre} value={genre} />
          ))}
        </datalist>
      </Field>
      <OptionSelect
        label="观感偏好"
        values={creativeTones}
        value={options.tone}
        change={(tone) => patch({ tone })}
      />
      <OptionSelect
        label="受众偏好"
        values={creativeAudiences}
        value={options.audience}
        change={(audience) => patch({ audience })}
      />
    </div>
  );
}
