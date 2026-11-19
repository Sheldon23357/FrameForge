import { useEffect, useState } from 'react';
import {
  ArrowClockwise,
  FileText,
  FolderOpen,
  FolderSimple,
  WarningCircle,
} from '@phosphor-icons/react';
import type { AgentSkillsAPI, SkillCatalog } from '../../../packages/agent/skills';
import { Button } from '../../components/ui';

export function AgentSkillSettings({ api }: { api: AgentSkillsAPI }) {
  const [catalog, setCatalog] = useState<SkillCatalog>();
  const [action, setAction] = useState<
    keyof Pick<AgentSkillsAPI, 'refresh' | 'chooseRoot' | 'openRoot'> | null
  >('refresh');
  const [error, setError] = useState('');
  const update = async (action: 'refresh' | 'chooseRoot' | 'openRoot') => {
    setAction(action);
    setError('');
    try {
      const next = await api[action]();
      if (next) setCatalog(next);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
          : '无法操作本地技能目录。',
      );
    } finally {
      setAction(null);
    }
  };
  useEffect(() => {
    void update('refresh');
  }, [api]);
  return (
    <div className="agent-settings-scroll agent-skill-settings" id="agent-skill-panel">
      <section className="agent-skill-directory" aria-labelledby="agent-skill-directory-title">
        <div className="agent-skill-directory-info">
          <span className="agent-skill-directory-icon" aria-hidden="true">
            <FolderSimple size={20} />
          </span>
          <div>
            <h3 id="agent-skill-directory-title">技能目录</h3>
            {catalog ? (
              <code className="agent-skill-root" title={catalog.root}>
                {catalog.root}
              </code>
            ) : (
              <p>{action ? '正在读取目录…' : '目录未加载'}</p>
            )}
          </div>
        </div>
        <div className="agent-skill-actions">
          <Button type="button" disabled={!!action} onClick={() => void update('chooseRoot')}>
            更改目录
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!!action || !catalog}
            onClick={() => void update('openRoot')}
          >
            <FolderOpen size={15} aria-hidden="true" />
            打开文件夹
          </Button>
        </div>
      </section>
      {error && (
        <p className="agent-skill-error" role="alert">
          <WarningCircle size={16} aria-hidden="true" /> {error}
        </p>
      )}
      <section className="agent-skill-library" aria-labelledby="agent-skill-library-title">
        <header className="agent-skill-library-heading">
          <div>
            <h3 id="agent-skill-library-title">技能列表</h3>
            <p role="status">
              {action === 'refresh'
                ? '正在扫描…'
                : catalog
                  ? `已识别 ${catalog.skills.length} 个技能`
                  : '等待扫描'}
            </p>
          </div>
          <Button type="button" disabled={!!action} onClick={() => void update('refresh')}>
            <ArrowClockwise size={15} aria-hidden="true" />
            刷新技能
          </Button>
        </header>
        {!!catalog?.issues.length && (
          <details className="agent-skill-issues" open={!catalog.skills.length}>
            <summary>
              <WarningCircle size={16} aria-hidden="true" /> {catalog.issues.length} 条扫描提示
            </summary>
            <ul>
              {catalog.issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          </details>
        )}
        {catalog &&
          (catalog.skills.length ? (
            <ul className="agent-skill-list">
              {catalog.skills.map((skill) => (
                <li key={skill.name}>
                  <FileText size={18} aria-hidden="true" />
                  <div>
                    <strong title={skill.directory}>{skill.name}</strong>
                    <p>{skill.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="agent-skill-empty">
              <FileText size={24} aria-hidden="true" />
              <strong>还没有可用技能</strong>
              <p>
                放入包含 <code>SKILL.md</code> 的完整文件夹，再刷新技能。
              </p>
            </div>
          ))}
      </section>
    </div>
  );
}
