import { Plus, Trash } from '@phosphor-icons/react';
import { Condition, Project, Value } from '../../../packages/domain/schema';
import { IconButton } from '../../components/ui';
export function ValueInput({
  type,
  value,
  onChange,
}: {
  type: 'number' | 'boolean' | 'string';
  value: Value;
  onChange: (v: Value) => void;
}) {
  if (type === 'boolean')
    return (
      <select
        aria-label="布尔值"
        value={String(value)}
        onChange={(e) => onChange(e.target.value === 'true')}
      >
        <option value="true">是 / true</option>
        <option value="false">否 / false</option>
      </select>
    );
  return (
    <input
      aria-label="比较值"
      type={type === 'number' ? 'number' : 'text'}
      value={String(value)}
      onChange={(e) => onChange(type === 'number' ? Number(e.target.value) : e.target.value)}
    />
  );
}
function initial(p: Project, kind: string): Condition {
  if (kind === 'variable') {
    const v = p.variables[0];
    return { kind: 'variable', variableId: v?.id ?? '', op: 'gte', value: v?.initial ?? 0 };
  }
  if (kind === 'item') return { kind: 'item', itemId: p.items[0]?.id ?? '', op: 'gte', count: 1 };
  if (kind === 'visited') return { kind: 'visited', nodeId: p.scenes[0]?.id ?? '' };
  if (kind === 'not') return { kind: 'not', child: { kind: 'all', children: [] } };
  return { kind: kind === 'any' ? 'any' : 'all', children: [] };
}
export function ConditionEditor({
  value,
  onChange,
  project,
  depth = 0,
}: {
  value: Condition;
  onChange: (c: Condition) => void;
  project: Project;
  depth?: number;
}) {
  const c = value;
  const grouped = c.kind === 'all' || c.kind === 'any';
  const simple = c.kind === 'variable' || c.kind === 'item' || c.kind === 'visited';
  return (
    <div
      className={`condition-editor ${depth ? 'nested' : ''} ${simple ? 'simple-condition' : ''}`}
    >
      <div className="rule-line">
        <select
          aria-label="条件类型"
          title={
            {
              all: '全部满足（AND）',
              any: '任一满足（OR）',
              not: '条件取反（NOT）',
              variable: '属性判定',
              item: '道具判定',
              visited: '访问过节点',
            }[c.kind]
          }
          value={c.kind}
          onChange={(e) => onChange(initial(project, e.target.value))}
        >
          <option value="all">全部满足（AND）</option>
          <option value="any">任一满足（OR）</option>
          <option value="not">条件取反（NOT）</option>
          <option value="variable">属性判定</option>
          <option value="item">道具判定</option>
          <option value="visited">访问过节点</option>
        </select>
        {grouped && depth < 6 && (
          <IconButton
            label="添加子条件"
            onClick={() =>
              onChange({
                ...c,
                children: [
                  ...c.children,
                  initial(project, project.variables.length ? 'variable' : 'item'),
                ],
              })
            }
          >
            <Plus size={15} />
          </IconButton>
        )}
      </div>
      {grouped && (
        <div className="condition-children">
          {!c.children.length && (
            <div className="rule-note">{c.kind === 'all' ? '无条件' : '无有效条件'}</div>
          )}
          {c.children.map((child, i) => (
            <div className="condition-child" key={i}>
              <ConditionEditor
                project={project}
                depth={depth + 1}
                value={child}
                onChange={(v) =>
                  onChange({ ...c, children: c.children.map((x, j) => (j === i ? v : x)) })
                }
              />
              <IconButton
                label="删除子条件"
                onClick={() => onChange({ ...c, children: c.children.filter((_, j) => j !== i) })}
              >
                <Trash size={13} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      {c.kind === 'not' && (
        <ConditionEditor
          project={project}
          depth={depth + 1}
          value={c.child}
          onChange={(child) => onChange({ ...c, child })}
        />
      )}
      {c.kind === 'variable' && (
        <>
          <select
            aria-label="判定属性"
            title={project.variables.find((v) => v.id === c.variableId)?.name}
            value={c.variableId}
            onChange={(e) => {
              const v = project.variables.find((v) => v.id === e.target.value)!;
              onChange({
                ...c,
                variableId: v.id,
                op: v.type === 'number' ? 'gte' : 'eq',
                value: v.initial,
              });
            }}
          >
            <option value="" disabled>
              选择属性
            </option>
            {project.variables.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <div className="condition-comparison">
            <select
              aria-label="比较方式"
              title={`比较方式：${{ eq: '等于', ne: '不等于', gte: '大于等于', gt: '大于', lte: '小于等于', lt: '小于' }[c.op]}`}
              value={c.op}
              onChange={(e) => onChange({ ...c, op: e.target.value as typeof c.op })}
            >
              {[
                ['eq', '等于'],
                ['ne', '不等于'],
                ...((project.variables.find((v) => v.id === c.variableId)?.type ?? 'number') ===
                'number'
                  ? [
                      ['gte', '大于等于 ≥'],
                      ['gt', '大于 >'],
                      ['lte', '小于等于 ≤'],
                      ['lt', '小于 <'],
                    ]
                  : []),
              ].map(([v, t]) => (
                <option key={v} value={v} title={t}>
                  {{ eq: '=', ne: '≠', gte: '≥', gt: '>', lte: '≤', lt: '<' }[v as typeof c.op]}
                </option>
              ))}
            </select>
            <ValueInput
              type={project.variables.find((v) => v.id === c.variableId)?.type ?? 'number'}
              value={c.value}
              onChange={(value) => onChange({ ...c, value })}
            />
          </div>
        </>
      )}
      {c.kind === 'item' && (
        <>
          <select
            aria-label="判定道具"
            title={project.items.find((item) => item.id === c.itemId)?.name}
            value={c.itemId}
            onChange={(e) => onChange({ ...c, itemId: e.target.value })}
          >
            <option value="" disabled>
              选择道具
            </option>
            {project.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          <div className="condition-comparison">
            <select
              aria-label="道具比较方式"
              title={`道具数量：${{ gte: '至少', eq: '等于', lt: '少于' }[c.op]}`}
              value={c.op}
              onChange={(e) => onChange({ ...c, op: e.target.value as typeof c.op })}
            >
              <option value="gte" title="数量至少">
                ≥
              </option>
              <option value="eq" title="数量等于">
                =
              </option>
              <option value="lt" title="数量少于">
                &lt;
              </option>
            </select>
            <input
              aria-label="道具数量条件"
              type="number"
              min="0"
              value={c.count}
              onChange={(e) =>
                onChange({ ...c, count: Math.max(0, Math.floor(Number(e.target.value))) })
              }
            />
          </div>
        </>
      )}
      {c.kind === 'visited' && (
        <select
          aria-label="访问过的节点"
          value={c.nodeId}
          onChange={(e) => onChange({ ...c, nodeId: e.target.value })}
        >
          {project.scenes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
export function conditionSummary(c: Condition, p: Project): string {
  if (c.kind === 'all' || c.kind === 'any')
    return c.children.length
      ? c.children.map((x) => conditionSummary(x, p)).join(c.kind === 'all' ? ' 且 ' : ' 或 ')
      : c.kind === 'all'
        ? '无条件'
        : '无有效条件';
  if (c.kind === 'not') return `非（${conditionSummary(c.child, p)}）`;
  if (c.kind === 'item')
    return `${p.items.find((i) => i.id === c.itemId)?.name ?? '未知道具'} ${c.op === 'gte' ? '≥' : c.op === 'eq' ? '=' : '<'} ${c.count}`;
  if (c.kind === 'visited')
    return `访问过 ${p.scenes.find((n) => n.id === c.nodeId)?.title ?? '未知节点'}`;
  if (c.kind === 'variable')
    return `${p.variables.find((v) => v.id === c.variableId)?.name ?? '未知属性'} ${{ eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }[c.op]} ${String(c.value)}`;
  return '';
}
