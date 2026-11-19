import {
  agentSettingsSchema,
  defaultAgentSettings,
  settingsProviderIds,
  providers,
  saveAgentSettingsSchema,
  type AgentSettingsAPI,
  type AgentSettingsSnapshot,
} from '../../packages/agent/settings';

const storageKey = 'frameforge.agent-settings.v1';
// Browser previews keep manual keys in memory only, never in localStorage or project data.
const sessionKeys = new Map<string, string>();
function browserSnapshot(): AgentSettingsSnapshot {
  const raw = localStorage.getItem(storageKey);
  const parsed = raw ? agentSettingsSchema.safeParse(JSON.parse(raw)) : undefined;
  if (parsed && !parsed.success) throw new Error('模型设置无效，请清除浏览器中的模型设置后重试。');
  return {
    ...(parsed?.success ? parsed.data : defaultAgentSettings()),
    desktop: false,
    secureStorageAvailable: false,
    credentials: Object.fromEntries(
      settingsProviderIds.map((id) => [
        id,
        {
          environmentName: providers[id].envNames[0] ?? '',
          environmentAvailable: false,
          hasManualKey: sessionKeys.has(id),
          manualKeyAvailable: sessionKeys.has(id),
        },
      ]),
    ) as AgentSettingsSnapshot['credentials'],
  };
}
const browserAgentSettings: AgentSettingsAPI = {
  findCodexPrograms: async () => [],
  listCodexModels: async () => ({ ok: false, message: '模型列表请在桌面版查看。' }),
  chooseCodexProgram: async () => null,
  get: async () => browserSnapshot(),
  save: async (input) => {
    const parsed = saveAgentSettingsSchema.parse(input);
    const settings = agentSettingsSchema.parse({
      ...parsed,
      imageProvider: parsed.imageProvider ?? browserSnapshot().imageProvider,
      version: 1,
    });
    localStorage.setItem(storageKey, JSON.stringify(settings));
    for (const id of settingsProviderIds) {
      const draft = parsed.providers[id];
      if (draft.clearApiKey) sessionKeys.delete(id);
      if (draft.apiKey) sessionKeys.set(id, draft.apiKey);
    }
    return browserSnapshot();
  },
  test: async () => ({ ok: false, message: '连接测试请使用桌面版。' }),
  cancelConnectionTest: async () => {},
};
export const agentSettings: AgentSettingsAPI =
  window.frameforge?.agentSettings ?? browserAgentSettings;
