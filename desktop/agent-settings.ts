import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite } from './files';
import { CodexCliSession, findCodexPrograms, launchCodex, type CodexLauncher } from './codex-cli';
import { testDoubaoAudio } from './doubao-audio';
import {
  agentSettingsSchema,
  defaultAgentSettings,
  settingsProviderIds,
  doubaoTestPrompt,
  providerConfigSchema,
  providers,
  saveAgentSettingsSchema,
  testAgentConnectionSchema,
  connectionRequest,
  type AgentSettingsAPI,
  type ProviderId,
  type SettingsProviderId,
  type ProviderDraft,
  type AgentSettingsSnapshot,
  type SaveAgentSettings,
  type TestAgentConnection,
  type ConnectionResult,
  type CodexModelCatalog,
  type ImageProvider,
} from '../packages/agent/settings';

export interface SecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
const storedSchema = z.object({
  settings: agentSettingsSchema,
  encryptedKeys: z.record(z.string(), z.string()),
});
type StoredSettings = z.infer<typeof storedSchema>;

export class AgentSettingsService implements Omit<AgentSettingsAPI, 'chooseCodexProgram'> {
  private readonly file: string;
  private saving: Promise<unknown> = Promise.resolve();
  private testing = false;
  private testController?: AbortController;
  private catalogController?: AbortController;
  constructor(
    userData: string,
    private readonly secrets: SecretStorage,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly request: (url: string, init?: RequestInit) => Promise<Response> = fetch,
    private readonly codexLauncher: CodexLauncher = launchCodex,
  ) {
    this.file = path.join(userData, 'agent-settings.json');
  }

  private async read(): Promise<StoredSettings> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { settings: defaultAgentSettings(), encryptedKeys: {} };
      throw new Error('无法读取模型设置。请检查应用数据目录权限。');
    }
    try {
      return storedSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error('模型设置文件损坏或版本不兼容。原文件已保留。');
    }
  }
  private environment(id: SettingsProviderId) {
    const names: readonly string[] = providers[id].envNames;
    const name = names.find((name) => this.env[name]?.trim()) ?? names[0] ?? '';
    return { name, key: this.env[name]?.trim() ?? '' };
  }
  private manualKey(data: StoredSettings, id: SettingsProviderId): string {
    if (!data.encryptedKeys[id]) return '';
    if (!this.secrets.isEncryptionAvailable())
      throw new Error('系统密钥加密不可用，请使用环境变量。');
    try {
      return this.secrets.decryptString(Buffer.from(data.encryptedKeys[id], 'base64'));
    } catch {
      throw new Error('已保存的密钥无法解密，请重新填写。');
    }
  }
  private snapshot(data: StoredSettings): AgentSettingsSnapshot {
    return {
      ...data.settings,
      desktop: true,
      secureStorageAvailable: this.secrets.isEncryptionAvailable(),
      credentials: Object.fromEntries(
        settingsProviderIds.map((id) => {
          let manualKeyAvailable = false;
          try {
            manualKeyAvailable = !!this.manualKey(data, id);
          } catch {
            /* shown as unavailable */
          }
          const env = this.environment(id);
          return [
            id,
            {
              environmentName: env.name,
              environmentAvailable: !!env.key,
              hasManualKey: !!data.encryptedKeys[id],
              manualKeyAvailable,
            },
          ];
        }),
      ) as AgentSettingsSnapshot['credentials'],
    };
  }
  async get() {
    await this.saving;
    return this.snapshot(await this.read());
  }
  findCodexPrograms() {
    return findCodexPrograms(this.env);
  }
  cancelTest() {
    this.testController?.abort();
    this.catalogController?.abort();
  }
  async cancelConnectionTest() {
    this.testController?.abort();
  }
  async listCodexModels(cliPath: unknown): Promise<CodexModelCatalog> {
    const path = providerConfigSchema.shape.cliPath.safeParse(cliPath);
    if (!path.success) return { ok: false, message: '请检查 CLI 程序路径。' };
    this.catalogController?.abort();
    const controller = new AbortController();
    this.catalogController = controller;
    const session = new CodexCliSession(this.codexLauncher);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const config = { ...defaultAgentSettings().providers.codex, cliPath: path.data };
      return { ok: true, models: await session.listModels(config, controller.signal) };
    } catch (error) {
      return {
        ok: false,
        message: controller.signal.aborted
          ? '读取模型列表已停止或超时，请重试。'
          : error instanceof Error
            ? error.message
            : '无法读取本机模型列表。',
      };
    } finally {
      clearTimeout(timeout);
      session.close();
      if (this.catalogController === controller) this.catalogController = undefined;
    }
  }
  async save(input: SaveAgentSettings) {
    const parsed = saveAgentSettingsSchema.safeParse(input);
    if (!parsed.success) throw new Error('模型配置无效，请检查模型 ID、接口地址和密钥。');
    const task = this.saving.then(async () => {
      const data = await this.read();
      for (const id of settingsProviderIds) {
        const { apiKey, clearApiKey, ...config } = parsed.data.providers[id];
        if (id === 'codex') {
          delete data.encryptedKeys[id];
          data.settings.providers[id] = config;
          continue;
        }
        if (clearApiKey) delete data.encryptedKeys[id];
        if (apiKey) {
          if (!this.secrets.isEncryptionAvailable())
            throw new Error('系统密钥加密不可用，请使用环境变量。');
          data.encryptedKeys[id] = this.secrets.encryptString(apiKey).toString('base64');
        }
        data.settings.providers[id] = config;
      }
      data.settings.defaultProvider = parsed.data.defaultProvider;
      data.settings.imageProvider = parsed.data.imageProvider ?? data.settings.imageProvider;
      try {
        await atomicWrite(this.file, JSON.stringify(data, null, 2));
      } catch {
        throw new Error('模型设置保存失败。请检查应用数据目录权限。');
      }
      return this.snapshot(data);
    });
    this.saving = task.catch(() => {});
    return task;
  }
  private resolveKey(data: StoredSettings, id: SettingsProviderId, config: ProviderDraft) {
    const key =
      config.credentialSource === 'environment'
        ? this.environment(id).key
        : config.apiKey || (config.clearApiKey ? '' : this.manualKey(data, id));
    if (!key)
      throw new Error(
        config.credentialSource === 'environment'
          ? `未检测到 ${providers[id].envNames.join(' / ')}。请设置环境变量后重启应用，或手动填写密钥。`
          : '请填写 API Key。',
      );
    return key;
  }
  // Main-process use only; never expose this method through the preload bridge.
  async resolveModel(provider?: ProviderId) {
    await this.saving;
    const data = await this.read();
    const id = provider ?? data.settings.defaultProvider;
    const config = data.settings.providers[id];
    return {
      provider: id,
      config,
      apiKey: id === 'codex' ? '' : this.resolveKey(data, id, config),
    };
  }
  async resolveImage(provider?: ImageProvider) {
    await this.saving;
    const data = await this.read();
    const id = provider ?? data.settings.imageProvider;
    if (id === 'codex') return { provider: id, config: data.settings.providers.codex } as const;
    return {
      provider: id,
      apiKey: this.resolveKey(data, id, data.settings.providers.minimax),
      request: this.request,
    } as const;
  }
  async generateReferenceAudio(prompt: string, signal: AbortSignal, speechRate?: number) {
    await this.saving;
    const data = await this.read();
    const key = this.resolveKey(data, 'doubaoTts', data.settings.providers.doubaoTts);
    const result = await testDoubaoAudio(this.request, key, prompt, signal, speechRate).catch(
      () => {
        signal.throwIfAborted();
        throw new Error('豆包语音网络请求失败，请检查网络后重试。');
      },
    );
    if (!result.ok || !result.audio) throw new Error(result.message);
    return result.audio;
  }
  async test(input: TestAgentConnection): Promise<ConnectionResult> {
    if (this.testing) return { ok: false, message: '已有连接测试正在进行。' };
    this.testing = true;
    const start = Date.now();
    const controller = new AbortController();
    this.testController = controller;
    const timeoutMs = input?.provider === 'doubaoTts' ? 300000 : 25000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const parsed = testAgentConnectionSchema.safeParse(input);
      if (!parsed.success) return { ok: false, message: '请检查模型 ID、接口地址和密钥格式。' };
      const { provider, config } = parsed.data;
      if (provider === 'codex') {
        const session = new CodexCliSession(this.codexLauncher);
        try {
          const frame = await session.complete(
            config,
            {
              runId: 'connection-test',
              provider,
              system: 'Reply with OK only.',
              messages: [{ role: 'user', content: 'Reply with OK only.' }],
              tools: [],
              exchanges: [],
              maxOutputTokens: 256,
            },
            controller.signal,
          );
          if (!frame.text.trim() || frame.calls.length)
            return { ok: false, message: 'Codex CLI 未返回有效回复，请检查模型配置。' };
          return {
            ok: true,
            message: '连接成功，本机 Codex CLI 模型已响应。',
            latencyMs: Date.now() - start,
          };
        } catch (error) {
          return {
            ok: false,
            message: controller.signal.aborted
              ? 'Codex CLI 连接超时（25 秒），请检查 CLI 登录和网络。'
              : error instanceof Error
                ? error.message
                : 'Codex CLI 连接失败。',
          };
        } finally {
          session.close();
        }
      }
      await this.saving;
      const key = this.resolveKey(await this.read(), provider, config);
      if (provider === 'doubaoTts') {
        const audio = await testDoubaoAudio(
          this.request,
          key,
          parsed.data.audioPrompt ?? doubaoTestPrompt,
          controller.signal,
        );
        return audio.ok ? { ...audio, latencyMs: Date.now() - start } : audio;
      }
      const { url, init } = connectionRequest(provider, config, key);
      const response = await this.request(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const messages: Record<number, string> = {
          400: '请求参数不被支持，请检查模型 ID 与接口协议。',
          401: '密钥无效、已过期或与接口区域不匹配。',
          402: '账户余额不足。',
          403: '无权访问，请检查模型权限、密钥所属区域及接口地址。',
          404: '模型或接口不存在，请检查模型 ID 与接口地址。',
          429: '请求受限或额度不足，请稍后重试并检查账户配额。',
        };
        // Classify known vendor codes locally; never surface raw error bodies or messages.
        const failure = await response.json().catch(() => null);
        let message = messages[response.status] ?? '服务暂时不可用。';
        if (
          ['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached'].includes(
            failure?.error?.code,
          )
        )
          message = '账户余额或额度已用尽，请在服务商控制台充值或检查计费设置。';
        else if (failure?.error?.status === 'FAILED_PRECONDITION')
          message = /location|region|country/i.test(String(failure.error.message))
            ? '当前网络所在地区不受该服务支持。'
            : '账户尚不满足服务使用条件，请检查服务商控制台。';
        else if (
          Array.isArray(failure?.error?.details) &&
          failure.error.details.some((d: { reason?: string }) => d?.reason === 'API_KEY_INVALID')
        )
          message = 'API Key 无效，请重新填写。';
        return {
          ok: false,
          message: `HTTP ${response.status} · ${message}`,
        };
      }
      const payload = await response.json();
      if (
        !payload ||
        payload.error ||
        (payload.base_resp?.status_code && payload.base_resp.status_code !== 0)
      )
        return { ok: false, message: '服务返回错误，请检查密钥、账户状态及模型权限。' };
      const valid =
        provider === 'openai'
          ? ['completed', 'incomplete'].includes(payload.status) && Array.isArray(payload.output)
          : provider === 'gemini'
            ? Array.isArray(payload.candidates) && payload.candidates.length > 0
            : Array.isArray(payload.choices) && payload.choices.length > 0;
      if (!valid) return { ok: false, message: '响应格式与服务协议不匹配，请检查接口地址。' };
      return { ok: true, message: '连接成功，模型已响应。', latencyMs: Date.now() - start };
    } catch (error) {
      if (controller.signal.aborted)
        return {
          ok: false,
          message:
            timeoutMs === 25000
              ? '连接超时（25 秒），请检查网络或接口地址。'
              : '已停止等待音频生成，或请求已超时。',
        };
      // Only our own credential errors can be shown verbatim.
      const message = error instanceof Error ? error.message : '';
      const known = [
        '请填写 API Key。',
        '系统密钥加密不可用，请使用环境变量。',
        '已保存的密钥无法解密，请重新填写。',
      ];
      return {
        ok: false,
        message:
          known.includes(message) || message.startsWith('未检测到 ')
            ? message
            : '连接失败，请检查网络、代理、接口地址或模型设置文件。',
      };
    } finally {
      clearTimeout(timeout);
      this.testController = undefined;
      this.testing = false;
    }
  }
}
