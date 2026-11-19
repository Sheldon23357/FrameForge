import type { WorldSetting } from '../domain/schema';

const characterVisualMin = 200;
const characterVoiceMin = 50;

export const worldVisualGuide = `角色形象至少 ${characterVisualMin} 字，写清年龄感、五官、发型、体态、常态服饰和辨识特征，并与身份、性格相符。场景画面写清空间用途、布局和尺度、材质、光线、配色及固定陈设。`;
export const worldSoundGuide = `角色声音至少 ${characterVoiceMin} 字。根据角色性格写清音色、音高、咬字、说话节奏、停顿和语气，并说明这些特征怎样体现性格。场景环境声写清主要声源、远近层次和持续或间歇的变化。`;

export function validateAgentWorldDescriptions(
  kind: WorldSetting['kind'],
  fields: Pick<WorldSetting, 'visual' | 'sound'>,
  previous?: Pick<WorldSetting, 'visual' | 'sound'>,
) {
  if (kind !== 'character') return;
  const checks = [
    { field: 'visual', label: '角色形象', min: characterVisualMin },
    { field: 'sound', label: '角色声音描述', min: characterVoiceMin },
  ] as const;
  const issues = checks.flatMap(({ field, label, min }) => {
    const value = fields[field]?.trim();
    if (!value || value === previous?.[field]?.trim()) return [];
    const count = value.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    return count < min ? [`${label}至少 ${min} 字，目前 ${count} 字`] : [];
  });
  if (issues.length)
    throw new Error(`${issues.join('。')}。空白和标点不计。请补充具体特征后重试。`);
}
