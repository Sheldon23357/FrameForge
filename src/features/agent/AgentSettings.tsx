import { useEffect, useRef, useState, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowClockwise,
  CaretDown,
  CheckCircle,
  Eye,
  EyeSlash,
  PlugsConnected,
  Robot,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import {
  providerIds,
  imageProviderSchema,
  minimaxImageConcurrency,
  settingsProviderIds,
  doubaoTestPrompt,
  providers,
  saveAgentSettingsSchema,
  type AgentSettingsSnapshot,
  type SaveAgentSettings,
  type ProviderId,
  type SettingsProviderId,
  type ConnectionResult,
} from '../../../packages/agent/settings';
import { agentSettings } from '../../platform/agent-settings';
import { AgentSkillSettings } from './AgentSkillSettings';
import { Button, Field, IconButton } from '../../components/ui';
import { CodexModelPicker } from './CodexModelPicker';

function draftFrom(snapshot: AgentSettingsSnapshot): SaveAgentSettings {
  return {
    defaultProvider: snapshot.defaultProvider,
    imageProvider: snapshot.imageProvider,
    providers: structuredClone(snapshot.providers),
  };
}

function AudioTestPreview({ wavBase64 }: { wavBase64: string }) {
  const player = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = player.current!;
    const bytes = Uint8Array.from(atob(wavBase64), (character) => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    audio.src = url;
    return () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    };
  }, [wavBase64]);
  return (
    <audio
      ref={player}
      className="agent-audio-preview"
      aria-label="豆包测试音频"
      controls
      preload="metadata"
    />
  );
}

export function AgentSettings({
  open,
  onOpenChange,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [snapshot, setSnapshot] = useState<AgentSettingsSnapshot>();
  const [draft, setDraft] = useState<SaveAgentSettings>();
  const [selected, setSelected] = useState<SettingsProviderId>('openai');
  const [showSkills, setShowSkills] = useState(false);
  const skillsAPI = window.frameforge?.agentSkills;
  const [busy, setBusy] = useState<
    'loading' | 'saving' | 'testing' | 'finding' | 'choosing' | null
  >(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [results, setResults] = useState<Partial<Record<SettingsProviderId, ConnectionResult>>>({});
  const [audioPrompt, setAudioPrompt] = useState(doubaoTestPrompt);
  const [visibleKey, setVisibleKey] = useState(false);
  const [cliPrograms, setCliPrograms] = useState<string[]>([]);
  const [cliNotice, setCliNotice] = useState('');
  const [locatedPath, setLocatedPath] = useState<string>();
  const mounted = useRef(true);
  const load = async () => {
    setBusy('loading');
    setError('');
    try {
      const data = await agentSettings.get();
      if (!mounted.current) return;
      setSnapshot(data);
      setDraft(draftFrom(data));
      setSelected(data.defaultProvider);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '读取模型设置失败。');
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (open && !snapshot && !busy && !error) void load();
  }, [open, snapshot, busy, error]);
  const changeOpen = (value: boolean) => {
    if (busy === 'saving') return;
    if (!value && busy === 'testing' && selected === 'doubaoTts')
      void agentSettings.cancelConnectionTest().catch(() => {});
    setVisibleKey(false);
    onOpenChange(value);
  };
  const config = draft?.providers[selected];
  const credential = snapshot?.credentials[selected];
  const provider = providers[selected];
  const localCli = selected === 'codex';
  const audioProvider = selected === 'doubaoTts';
  const available =
    config &&
    credential &&
    (localCli
      ? snapshot?.desktop
      : config.credentialSource === 'environment'
        ? credential.environmentAvailable
        : !!config.apiKey?.trim() || (!config.clearApiKey && credential.manualKeyAvailable));
  const dirty =
    !!draft && !!snapshot && JSON.stringify(draft) !== JSON.stringify(draftFrom(snapshot));
  const result = results[selected];
  const update = (patch: Partial<NonNullable<typeof config>>) => {
    if (!draft || !config) return;
    setDraft({ ...draft, providers: { ...draft.providers, [selected]: { ...config, ...patch } } });
    setResults((r) => ({ ...r, [selected]: undefined }));
    setError('');
    setSaved(false);
  };
  const save = async () => {
    const parsed = saveAgentSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '模型配置无效。');
      return;
    }
    setBusy('saving');
    setError('');
    setSaved(false);
    setVisibleKey(false);
    try {
      const data = await agentSettings.save(parsed.data);
      if (!mounted.current) return;
      setSnapshot(data);
      setDraft(draftFrom(data));
      setSaved(true);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : '保存模型配置失败。');
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const test = async () => {
    if (!config) return;
    setBusy('testing');
    setError('');
    setResults((r) => ({ ...r, [selected]: undefined }));
    try {
      const value = await agentSettings.test({
        provider: selected,
        config,
        ...(audioProvider ? { audioPrompt } : {}),
      });
      if (mounted.current) setResults((r) => ({ ...r, [selected]: value }));
    } catch {
      if (mounted.current)
        setResults((r) => ({ ...r, [selected]: { ok: false, message: '连接测试失败，请重试。' } }));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const locateCli = async (browse: boolean) => {
    setBusy(browse ? 'choosing' : 'finding');
    setCliNotice('');
    try {
      if (browse) {
        const program = await agentSettings.chooseCodexProgram();
        if (mounted.current && program) {
          setLocatedPath(program);
          update({ cliPath: program });
        }
      } else {
        const programs = await agentSettings.findCodexPrograms();
        if (!mounted.current) return;
        setCliPrograms(programs);
        if (programs.length) {
          setLocatedPath(programs[0]);
          update({ cliPath: programs[0] });
        }
        setCliNotice(
          programs.length
            ? `找到 ${programs.length} 个本机程序，已填入首选路径。`
            : '未找到 Codex CLI，请浏览选择已安装的程序。',
        );
      }
    } catch {
      if (mounted.current) setCliNotice('查找失败，请浏览选择程序或手动填写路径。');
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const cliPath = config?.cliPath?.trim() ?? '';
  const setDefaultProvider = (id: ProviderId) => {
    if (!draft) return;
    setDraft({ ...draft, defaultProvider: id });
    setSaved(false);
    setError('');
  };
  const connectionTest = (
    <div className={localCli ? 'codex-connection' : undefined}>
      <div className="agent-test-row">
        <Button
          type="button"
          onClick={test}
          busy={busy === 'testing'}
          disabled={!available || !snapshot?.desktop || (audioProvider && !audioPrompt.trim())}
        >
          {busy !== 'testing' && <PlugsConnected size={15} />}
          {busy === 'testing' ? (audioProvider ? '正在生成…' : '正在测试…') : '测试连接'}
        </Button>
        {!localCli && !snapshot?.desktop && <span>连接测试请使用桌面版</span>}
      </div>
      {result && (
        <div className={`agent-test-result ${result.ok ? 'success' : 'failure'}`} role="status">
          {result.ok ? <CheckCircle size={16} /> : <WarningCircle size={16} />}
          <span>
            {result.message}
            {result.audio?.durationSeconds !== undefined &&
              ` · 音频 ${result.audio.durationSeconds.toFixed(2)} 秒`}
            {result.latencyMs !== undefined && ` · ${(result.latencyMs / 1000).toFixed(2)} 秒`}
          </span>
        </div>
      )}
      {result?.audio && <AudioTestPreview wavBase64={result.audio.wavBase64} />}
    </div>
  );
  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="app-settings-overlay" />
        <Dialog.Content
          className="app-settings-dialog"
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            returnFocusRef.current?.focus();
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              e.stopPropagation();
              if (dirty && !busy) void save();
            }
          }}
        >
          <aside className="app-settings-sidebar">
            <Dialog.Title className="app-settings-title">设置</Dialog.Title>
            <div className="app-settings-category">
              <Robot size={17} />
              <span>模型设置</span>
            </div>
            <div
              className="agent-provider-tabs"
              role="tablist"
              aria-label="模型服务商"
              aria-orientation="vertical"
            >
              {settingsProviderIds.map((id) => {
                const c = snapshot?.credentials[id];
                const d = draft?.providers[id];
                const ready =
                  d?.credentialSource === 'environment'
                    ? c?.environmentAvailable
                    : !!d?.apiKey?.trim() || (!d?.clearApiKey && c?.manualKeyAvailable);
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    id={`provider-tab-${id}`}
                    aria-selected={!showSkills && selected === id}
                    aria-controls="agent-provider-panel"
                    tabIndex={selected === id ? 0 : -1}
                    disabled={!!busy || !snapshot}
                    onKeyDown={(e) => {
                      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
                      e.preventDefault();
                      const index =
                        e.key === 'Home'
                          ? 0
                          : e.key === 'End'
                            ? settingsProviderIds.length - 1
                            : (settingsProviderIds.indexOf(id) +
                                (e.key === 'ArrowDown' ? 1 : -1) +
                                settingsProviderIds.length) %
                              settingsProviderIds.length;
                      setSelected(settingsProviderIds[index]);
                      setVisibleKey(false);
                      document
                        .getElementById(`provider-tab-${settingsProviderIds[index]}`)
                        ?.focus();
                    }}
                    onClick={() => {
                      setShowSkills(false);
                      setSelected(id);
                      setVisibleKey(false);
                    }}
                  >
                    <span>{providers[id].name}</span>
                    <span
                      className={`agent-provider-dot ${ready ? 'configured' : ''}`}
                      aria-hidden="true"
                      title={
                        id === 'codex' ? '使用本机 CLI 登录状态' : ready ? '密钥已配置' : '待配置'
                      }
                    />
                  </button>
                );
              })}
            </div>
            {skillsAPI && (
              <div className="agent-provider-tabs">
                <button
                  type="button"
                  aria-pressed={showSkills}
                  disabled={!!busy}
                  onClick={() => setShowSkills(true)}
                >
                  本地技能
                </button>
              </div>
            )}
            <span className="app-settings-app-name">帧叙</span>
          </aside>
          <div className="app-settings-main">
            <header className="app-settings-heading">
              <h2>{showSkills ? '本地技能' : '模型设置'}</h2>
              <IconButton
                label="关闭设置"
                disabled={busy === 'saving'}
                onClick={() => changeOpen(false)}
              >
                <X size={19} />
              </IconButton>
            </header>
            {showSkills && skillsAPI ? (
              <AgentSkillSettings api={skillsAPI} />
            ) : !snapshot || !draft || !config || !credential ? (
              <div className="agent-load-state">
                <p role="status">{error || '正在读取模型配置…'}</p>
                {error && <Button onClick={load}>重新读取</Button>}
              </div>
            ) : (
              <form
                className="agent-settings-form"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <div className="agent-settings-scroll">
                  <fieldset disabled={!!busy} className="agent-settings-fields">
                    {!localCli && !audioProvider && (
                      <Field label="默认模型">
                        <select
                          aria-label="默认模型"
                          value={draft.defaultProvider}
                          onChange={(e) => setDefaultProvider(e.target.value as ProviderId)}
                        >
                          {providerIds.map((id) => (
                            <option key={id} value={id}>
                              {providers[id].name} · {draft.providers[id].model}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                    <Field label="图像服务">
                      <select
                        aria-label="图像服务"
                        value={draft.imageProvider}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            imageProvider: imageProviderSchema.parse(e.target.value),
                          })
                        }
                      >
                        <option value="codex">Codex CLI</option>
                        <option value="minimax">MiniMax H3 Image</option>
                      </select>
                    </Field>
                    {draft.imageProvider === 'minimax' && (
                      <p className="agent-field-note">
                        设定图和分镜图复用 MiniMax 的 API Key，最多同时生成{' '}
                        {minimaxImageConcurrency} 张。
                      </p>
                    )}
                    <section
                      className={`agent-provider-panel${localCli ? ' codex-settings' : ''}`}
                      id="agent-provider-panel"
                      role="tabpanel"
                      aria-labelledby={`provider-tab-${selected}`}
                    >
                      <div className="agent-provider-heading">
                        <h3>{provider.name}</h3>
                        {localCli && draft.defaultProvider !== 'codex' ? (
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setDefaultProvider('codex')}
                          >
                            设为默认
                          </Button>
                        ) : (
                          <span>
                            {localCli ? '当前默认' : available ? '密钥已配置' : '未配置密钥'}
                          </span>
                        )}
                      </div>
                      {audioProvider && (
                        <p className="agent-field-note">
                          {provider.label} · {provider.model}
                        </p>
                      )}
                      {!localCli && !audioProvider && (
                        <Field label="模型 ID">
                          <input
                            value={config.model}
                            onChange={(e) => update({ model: e.target.value })}
                            required
                            maxLength={200}
                            spellCheck={false}
                            autoComplete="off"
                          />
                        </Field>
                      )}
                      {localCli ? (
                        <>
                          <CodexModelPicker
                            key={cliPath}
                            cliPath={cliPath}
                            desktop={snapshot.desktop}
                            autoLoad={
                              cliPath === (snapshot.providers.codex.cliPath ?? '') ||
                              cliPath === locatedPath ||
                              !cliPath
                            }
                            model={config.model}
                            onChange={(model) => update({ model })}
                          />
                          {connectionTest}
                          <details className="agent-advanced" key="codex-advanced">
                            <summary>
                              高级设置
                              <CaretDown size={14} />
                            </summary>
                            <Field label="模型 ID">
                              <input
                                value={config.model}
                                onChange={(e) => update({ model: e.target.value })}
                                maxLength={200}
                                spellCheck={false}
                                autoComplete="off"
                              />
                            </Field>
                            <Field label="CLI 程序路径">
                              <input
                                value={config.cliPath ?? ''}
                                onChange={(e) => update({ cliPath: e.target.value })}
                                placeholder="留空自动搜索本机 Codex CLI"
                                maxLength={4096}
                                spellCheck={false}
                                autoComplete="off"
                              />
                            </Field>
                            <div className="agent-endpoint-actions">
                              <Button
                                type="button"
                                onClick={() => locateCli(false)}
                                busy={busy === 'finding'}
                                disabled={!snapshot.desktop}
                              >
                                自动查找
                              </Button>
                              <Button
                                type="button"
                                onClick={() => locateCli(true)}
                                disabled={!snapshot.desktop}
                              >
                                浏览选择程序
                              </Button>
                            </div>
                            {cliPrograms.length > 1 && (
                              <Field label="已找到的程序">
                                <select
                                  value={config.cliPath ?? ''}
                                  onChange={(e) => {
                                    setLocatedPath(e.target.value);
                                    update({ cliPath: e.target.value });
                                  }}
                                >
                                  {!cliPrograms.includes(config.cliPath ?? '') && (
                                    <option value={config.cliPath ?? ''}>当前路径</option>
                                  )}
                                  {cliPrograms.map((program) => (
                                    <option key={program} value={program}>
                                      {program}
                                    </option>
                                  ))}
                                </select>
                              </Field>
                            )}
                            {cliNotice && (
                              <p className="agent-field-note" role="status">
                                {cliNotice}
                              </p>
                            )}
                          </details>
                        </>
                      ) : (
                        <>
                          <Field label="密钥来源">
                            <select
                              aria-label="密钥来源"
                              value={config.credentialSource}
                              onChange={(e) => {
                                update({
                                  credentialSource: e.target.value as 'environment' | 'manual',
                                });
                                setVisibleKey(false);
                              }}
                            >
                              <option value="environment">环境变量</option>
                              <option value="manual">手动填写</option>
                            </select>
                          </Field>
                          {config.credentialSource === 'environment' ? (
                            <div className="agent-credential-detail">
                              <span>环境变量</span>
                              <div>
                                <code>{credential.environmentName}</code>
                                <span>
                                  {credential.environmentAvailable
                                    ? '已检测到'
                                    : snapshot.desktop
                                      ? '未检测到'
                                      : '浏览器无法读取'}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="field">
                                <label className="field-label" htmlFor="agent-api-key">
                                  API Key
                                </label>
                                <span className="agent-secret-input">
                                  <input
                                    id="agent-api-key"
                                    aria-label="API Key"
                                    value={config.apiKey ?? ''}
                                    type={visibleKey ? 'text' : 'password'}
                                    autoComplete="off"
                                    spellCheck={false}
                                    placeholder={
                                      credential.hasManualKey && !config.clearApiKey
                                        ? '已保存密钥；留空保留'
                                        : '输入 API Key'
                                    }
                                    maxLength={8192}
                                    onChange={(e) =>
                                      update({
                                        apiKey: e.target.value,
                                        ...(e.target.value ? { clearApiKey: false } : {}),
                                      })
                                    }
                                  />
                                  <IconButton
                                    type="button"
                                    label={visibleKey ? '隐藏输入' : '显示输入'}
                                    disabled={!config.apiKey}
                                    onClick={() => setVisibleKey(!visibleKey)}
                                  >
                                    {visibleKey ? <EyeSlash size={16} /> : <Eye size={16} />}
                                  </IconButton>
                                </span>
                              </div>
                              <div className="agent-key-actions">
                                <span>
                                  {snapshot.desktop
                                    ? snapshot.secureStorageAvailable
                                      ? '系统加密 · 仅保存在本机'
                                      : '系统加密不可用，请使用环境变量'
                                    : '仅保留在本次页面会话中'}
                                </span>
                                {credential.hasManualKey && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() =>
                                      update({ clearApiKey: !config.clearApiKey, apiKey: '' })
                                    }
                                  >
                                    {config.clearApiKey ? '取消移除密钥' : '移除已保存密钥'}
                                  </Button>
                                )}
                                {config.clearApiKey && <span>保存后移除</span>}
                              </div>
                              {credential.hasManualKey &&
                                !credential.manualKeyAvailable &&
                                !config.clearApiKey && (
                                  <p className="agent-field-note" role="alert">
                                    已保存密钥无法解密，请重新填写。
                                  </p>
                                )}
                            </>
                          )}
                          {audioProvider ? (
                            <Field label="测试文本">
                              <textarea
                                rows={3}
                                value={audioPrompt}
                                maxLength={3000}
                                onChange={(e) => {
                                  setAudioPrompt(e.target.value);
                                  setResults((previous) => ({ ...previous, doubaoTts: undefined }));
                                }}
                              />
                            </Field>
                          ) : (
                            <details className="agent-advanced" key={selected}>
                              <summary>
                                高级设置
                                <CaretDown size={14} />
                              </summary>
                              <Field label="接口地址">
                                <input
                                  value={config.baseUrl}
                                  onChange={(e) => update({ baseUrl: e.target.value })}
                                  type="url"
                                  required
                                  spellCheck={false}
                                  autoComplete="off"
                                />
                              </Field>
                              {selected === 'minimax' && (
                                <div
                                  className="agent-endpoint-actions"
                                  aria-label="MiniMax 接口区域"
                                >
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() =>
                                      update({ baseUrl: 'https://api.minimaxi.com/v1' })
                                    }
                                  >
                                    国内接口
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => update({ baseUrl: 'https://api.minimax.io/v1' })}
                                  >
                                    国际接口
                                  </Button>
                                </div>
                              )}
                              <div className="agent-protocol">
                                <span>接口协议</span>
                                <span>{provider.protocol}</span>
                              </div>
                              {selected === 'deepseek' && config.model === 'deepseek-v4-flash' && (
                                <p className="agent-field-note">
                                  该模型 ID 由官方兼容保留，目前请求由 V4.1 Flash 承接。
                                </p>
                              )}
                              <Button
                                className="agent-reset"
                                type="button"
                                variant="ghost"
                                onClick={() =>
                                  update({ model: provider.model, baseUrl: provider.baseUrl })
                                }
                              >
                                <ArrowClockwise size={14} />
                                恢复默认模型与地址
                              </Button>
                            </details>
                          )}
                        </>
                      )}
                      {!localCli && connectionTest}
                    </section>
                  </fieldset>
                  {error && (
                    <div className="agent-settings-error" role="alert">
                      <WarningCircle size={16} />
                      {error}
                    </div>
                  )}
                </div>
                <footer className="agent-settings-footer">
                  <span className="agent-save-state" role="status">
                    {dirty ? '有未保存的修改' : saved ? '已保存' : ''}
                  </span>
                  {audioProvider && busy === 'testing' ? (
                    <Button
                      type="button"
                      onClick={() => void agentSettings.cancelConnectionTest().catch(() => {})}
                    >
                      停止等待
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      variant="primary"
                      busy={busy === 'saving'}
                      disabled={!dirty || !!busy}
                    >
                      保存设置
                    </Button>
                  )}
                </footer>
              </form>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
