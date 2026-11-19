import { Plus, Trash } from '@phosphor-icons/react';
import { Effect, Project } from '../../../packages/domain/schema';
import { Button, IconButton } from '../../components/ui';
import { ValueInput } from './ConditionEditor';
function initial(p: Project, kind: string): Effect {
  if (kind === 'showMessage') return { kind, title: '剧情提示', text: '新的剧情反馈' };
  if (kind === 'addItem' || kind === 'removeItem')
    return { kind, itemId: p.items[0]?.id ?? '', count: 1 };
  if (kind === 'setVariable')
    return { kind, variableId: p.variables[0]?.id ?? '', value: p.variables[0]?.initial ?? 0 };
  return {
    kind: 'addVariable',
    variableId: p.variables.find((v) => v.type === 'number')?.id ?? '',
    value: 1,
  };
}
export function EffectEditor({
  value,
  onChange,
  project,
}: {
  value: Effect[];
  onChange: (e: Effect[]) => void;
  project: Project;
}) {
  const update = (i: number, e: Effect) => onChange(value.map((x, j) => (j === i ? e : x)));
  return (
    <div className="effect-editor">
      {value.map((effect, i) => (
        <div className="effect-row" key={i}>
          <div className="rule-line">
            <span className="rule-number">{i + 1}</span>
            <select
              aria-label="效果类型"
              value={effect.kind}
              onChange={(e) => update(i, initial(project, e.target.value))}
            >
              <option value="addVariable">增减属性</option>
              <option value="setVariable">设置属性</option>
              <option value="addItem">获得道具</option>
              <option value="removeItem">消耗道具</option>
              <option value="showMessage">剧情提示</option>
            </select>
            <IconButton label="删除效果" onClick={() => onChange(value.filter((_, j) => i !== j))}>
              <Trash size={14} />
            </IconButton>
          </div>
          {effect.kind === 'showMessage' ? (
            <>
              <input
                aria-label="剧情提示标题"
                value={effect.title}
                maxLength={100}
                onChange={(e) => update(i, { ...effect, title: e.target.value })}
              />
              <textarea
                aria-label="剧情提示内容"
                value={effect.text}
                maxLength={2000}
                rows={3}
                onChange={(e) => update(i, { ...effect, text: e.target.value })}
              />
            </>
          ) : effect.kind === 'addItem' || effect.kind === 'removeItem' ? (
            <div className="rule-line">
              <select
                aria-label="效果道具"
                value={effect.itemId}
                onChange={(e) => update(i, { ...effect, itemId: e.target.value })}
              >
                <option value="" disabled>
                  选择道具
                </option>
                {project.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <input
                aria-label="效果道具数量"
                type="number"
                min="1"
                value={effect.count}
                onChange={(e) =>
                  update(i, { ...effect, count: Math.max(1, Math.floor(Number(e.target.value))) })
                }
              />
            </div>
          ) : (
            <>
              <select
                aria-label="效果属性"
                value={effect.variableId}
                onChange={(e) => {
                  const v = project.variables.find((v) => v.id === e.target.value)!;
                  update(
                    i,
                    effect.kind === 'setVariable'
                      ? { ...effect, variableId: v.id, value: v.initial }
                      : { ...effect, variableId: v.id },
                  );
                }}
              >
                <option value="" disabled>
                  选择属性
                </option>
                {project.variables
                  .filter((v) => effect.kind !== 'addVariable' || v.type === 'number')
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
              </select>
              <ValueInput
                type={
                  effect.kind === 'addVariable'
                    ? 'number'
                    : (project.variables.find((v) => v.id === effect.variableId)?.type ?? 'number')
                }
                value={effect.value}
                onChange={(v) =>
                  update(
                    i,
                    effect.kind === 'addVariable'
                      ? { ...effect, value: Number(v) }
                      : { ...effect, value: v },
                  )
                }
              />
            </>
          )}
        </div>
      ))}
      <Button
        variant="ghost"
        className="add-rule"
        onClick={() =>
          onChange([
            ...value,
            initial(project, project.variables.length ? 'addVariable' : 'addItem'),
          ])
        }
      >
        <Plus size={14} />
        添加效果
      </Button>
    </div>
  );
}
