import { useState } from 'react';
import { Plus, SlidersHorizontal, Package, Trash, MagnifyingGlass } from '@phosphor-icons/react';
import { uid, type Item, type Variable } from '../../../packages/domain/schema';
import { useEditor } from '../../store/editor';
import { Button, Empty, Field, IconButton, Modal, Toggle } from '../../components/ui';
import { ValueInput } from '../rules/ConditionEditor';
export function GameData() {
  const p = useEditor((s) => s.project);
  const commit = useEditor((s) => s.commit);
  const [tab, setTab] = useState<'variables' | 'items'>('variables');
  const [search, setSearch] = useState('');
  const [remove, setRemove] = useState<{
    type: 'variables' | 'items';
    id: string;
    name: string;
  } | null>(null);
  const variable = (id: string, v: Partial<Variable>) =>
    commit(
      (p) => {
        Object.assign(
          p.variables.find((x) => x.id === id)!,
          v,
        );
      },
      `variable:${id}:${Object.keys(v).join(',')}`,
    );
  const item = (id: string, v: Partial<Item>) =>
    commit(
      (p) => {
        Object.assign(
          p.items.find((x) => x.id === id)!,
          v,
        );
      },
      `item:${id}:${Object.keys(v).join(',')}`,
    );
  return (
    <main className="data-page">
      <div className="page-heading">
        <h1>参数</h1>
      </div>
      <div className="data-toolbar">
        <div className="data-tabs">
          <button
            className={tab === 'variables' ? 'active' : ''}
            onClick={() => setTab('variables')}
          >
            <SlidersHorizontal size={17} />
            属性参数<span>{p.variables.length}</span>
          </button>
          <button className={tab === 'items' ? 'active' : ''} onClick={() => setTab('items')}>
            <Package size={17} />
            道具<span>{p.items.length}</span>
          </button>
        </div>
        <Button
          variant="primary"
          onClick={() =>
            commit((p) => {
              if (tab === 'variables')
                p.variables.push({
                  id: uid('var'),
                  name: '新的属性',
                  type: 'number',
                  initial: 0,
                  hidden: false,
                });
              else p.items.push({ id: uid('item'), name: '新的道具', description: '', initial: 0 });
            })
          }
        >
          <Plus size={16} />
          添加{tab === 'variables' ? '属性' : '道具'}
        </Button>
      </div>
      <div className="data-content">
        <div className="search-input">
          <MagnifyingGlass size={16} />
          <input
            aria-label="搜索游戏数据"
            placeholder="搜索名称…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {tab === 'variables' ? (
          <div className="definition-list">
            {!p.variables.length && <Empty icon={<SlidersHorizontal size={34} />}>暂无属性</Empty>}
            {p.variables
              .filter((v) => v.name.includes(search))
              .map((v) => (
                <div className="definition-card" key={v.id}>
                  <div className="definition-heading">
                    <span className="definition-symbol">
                      {v.type === 'number' ? '#' : v.type === 'boolean' ? '?' : 'Aa'}
                    </span>
                    <div>
                      <strong title={v.name}>{v.name}</strong>
                      <code title={v.id}>{v.id}</code>
                    </div>
                  </div>
                  <div
                    className={`definition-fields variable-fields ${v.type !== 'number' ? 'simple-fields' : ''}`}
                  >
                    <Field label="显示名称">
                      <input
                        value={v.name}
                        onChange={(e) => variable(v.id, { name: e.target.value })}
                      />
                    </Field>
                    <Field label="属性类型">
                      <select
                        value={v.type}
                        onChange={(e) => {
                          const type = e.target.value as Variable['type'];
                          variable(v.id, {
                            type,
                            initial: type === 'number' ? 0 : type === 'boolean' ? false : '',
                            min: undefined,
                            max: undefined,
                          });
                        }}
                      >
                        <option value="number">数值</option>
                        <option value="boolean">开关</option>
                        <option value="string">文本</option>
                      </select>
                    </Field>
                    <Field label="初始值">
                      <ValueInput
                        type={v.type}
                        value={v.initial}
                        onChange={(initial) => variable(v.id, { initial })}
                      />
                    </Field>
                    {v.type === 'number' && (
                      <>
                        <Field label="最小值（可选）">
                          <input
                            type="number"
                            value={v.min ?? ''}
                            placeholder="不限"
                            onChange={(e) =>
                              variable(v.id, {
                                min: e.target.value === '' ? undefined : Number(e.target.value),
                              })
                            }
                          />
                        </Field>
                        <Field label="最大值（可选）">
                          <input
                            type="number"
                            value={v.max ?? ''}
                            placeholder="不限"
                            onChange={(e) =>
                              variable(v.id, {
                                max: e.target.value === '' ? undefined : Number(e.target.value),
                              })
                            }
                          />
                        </Field>
                      </>
                    )}
                    <div className="variable-visibility">
                      <Toggle
                        label="隐藏属性"
                        checked={!!v.hidden}
                        onChange={(hidden) => variable(v.id, { hidden })}
                      />
                    </div>
                  </div>
                  <IconButton
                    label={`删除属性 ${v.name}`}
                    onClick={() => setRemove({ type: 'variables', id: v.id, name: v.name })}
                  >
                    <Trash size={16} />
                  </IconButton>
                </div>
              ))}
          </div>
        ) : (
          <div className="definition-list">
            {!p.items.length && <Empty icon={<Package size={34} />}>暂无道具</Empty>}
            {p.items
              .filter((i) => i.name.includes(search))
              .map((i) => (
                <div className="definition-card" key={i.id}>
                  <div className="definition-heading">
                    <span className="definition-symbol">
                      <Package size={18} weight="duotone" />
                    </span>
                    <div>
                      <strong title={i.name}>{i.name}</strong>
                      <code title={i.id}>{i.id}</code>
                    </div>
                  </div>
                  <div className="definition-fields item-fields">
                    <Field label="道具名称">
                      <input
                        value={i.name}
                        onChange={(e) => item(i.id, { name: e.target.value })}
                      />
                    </Field>
                    <Field label="初始持有数量">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={i.initial}
                        onChange={(e) =>
                          item(i.id, { initial: Math.max(0, Math.floor(Number(e.target.value))) })
                        }
                      />
                    </Field>
                    <Field label="道具描述">
                      <input
                        value={i.description}
                        onChange={(e) => item(i.id, { description: e.target.value })}
                      />
                    </Field>
                  </div>
                  <IconButton
                    label={`删除道具 ${i.name}`}
                    onClick={() => setRemove({ type: 'items', id: i.id, name: i.name })}
                  >
                    <Trash size={16} />
                  </IconButton>
                </div>
              ))}
          </div>
        )}
      </div>
      <Modal
        open={!!remove}
        onOpenChange={(v) => !v && setRemove(null)}
        title={`删除「${remove?.name}」？`}
        description="引用此数据的条件和效果将保留，并在工程检查中报告错误。此操作可以撤销。"
      >
        <div className="dialog-actions">
          <Button onClick={() => setRemove(null)}>取消</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (remove)
                commit((p) => {
                  if (remove.type === 'variables')
                    p.variables = p.variables.filter((x) => x.id !== remove.id);
                  else p.items = p.items.filter((x) => x.id !== remove.id);
                });
              setRemove(null);
            }}
          >
            删除
          </Button>
        </div>
      </Modal>
    </main>
  );
}
