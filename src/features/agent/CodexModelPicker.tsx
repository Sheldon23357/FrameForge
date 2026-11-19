import { useEffect, useState } from 'react';
import type { CodexModelCatalog } from '../../../packages/agent/settings';
import { Button, Field } from '../../components/ui';
import { agentSettings } from '../../platform/agent-settings';

export function CodexModelPicker({
  cliPath,
  desktop,
  autoLoad,
  model,
  onChange,
}: {
  cliPath: string;
  desktop: boolean;
  autoLoad: boolean;
  model: string;
  onChange: (model: string) => void;
}) {
  const [catalog, setCatalog] = useState<CodexModelCatalog>();
  const [refresh, setRefresh] = useState(0);
  const load = desktop && (autoLoad || refresh > 0);
  useEffect(() => {
    if (!load) return;
    let current = true;
    const timer = setTimeout(() => {
      void agentSettings.listCodexModels(cliPath).then(
        (value) => {
          if (current) setCatalog(value);
        },
        () => {
          if (current) setCatalog({ ok: false, message: '无法读取本机模型列表。' });
        },
      );
    }, 100);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [load, cliPath, refresh]);
  const models = catalog?.ok ? catalog.models : [];
  const custom = model !== 'default' && !models.some((option) => option.id === model);
  const notice = !desktop
    ? '模型列表请在桌面版查看。'
    : !load
      ? '程序路径已修改。'
      : !catalog
        ? '正在读取本机模型…'
        : !catalog.ok
          ? catalog.message
          : !models.length
            ? '本机 CLI 未返回可选模型。'
            : '';
  return (
    <>
      <Field label="模型">
        <select value={model} onChange={(e) => onChange(e.target.value)}>
          <option value="default">跟随 Codex 默认设置</option>
          {models.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
          {custom && <option value={model}>{model || '未填写'}（手动指定）</option>}
        </select>
      </Field>
      {notice && (
        <div className="codex-model-notice">
          <span role="status">{notice}</span>
          {desktop && (!load || catalog) && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setCatalog(undefined);
                setRefresh((n) => n + 1);
              }}
            >
              {load ? '重新读取' : '读取模型'}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
