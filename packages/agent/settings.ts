import { z } from 'zod';

export const providerIds = ['openai', 'gemini', 'deepseek', 'minimax', 'codex'] as const;
export const providerIdSchema = z.enum(providerIds);
export type ProviderId = z.infer<typeof providerIdSchema>;
export const settingsProviderIds = [...providerIds, 'doubaoTts'] as const;
const settingsProviderIdSchema = z.enum(settingsProviderIds);
export type SettingsProviderId = z.infer<typeof settingsProviderIdSchema>;
export const doubaoTestPrompt =
  '用自然的普通话说：“你好，帧叙语音测试成功。”只说这一句，不添加背景音乐和音效。';

export const providers = {
  openai: {
    name: 'OpenAI',
    model: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    baseUrl: 'https://api.openai.com/v1',
    envNames: ['OPENAI_API_KEY'],
    protocol: 'Responses API',
  },
  gemini: {
    name: 'Gemini',
    model: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    envNames: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    protocol: 'Gemini API',
  },
  deepseek: {
    name: 'DeepSeek',
    model: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    baseUrl: 'https://api.deepseek.com',
    envNames: ['DEEPSEEK_API_KEY'],
    protocol: 'Chat Completions',
  },
  minimax: {
    name: 'MiniMax',
    model: 'MiniMax-M3.1-Flash',
    label: 'MiniMax M3.1 Flash',
    baseUrl: 'https://api.minimaxi.com/v1',
    envNames: ['MINIMAX_API_KEY'],
    protocol: 'Chat Completions',
  },
  codex: {
    name: 'Codex CLI',
    model: 'default',
    label: '本机 Codex 默认模型',
    baseUrl: 'https://api.openai.com/v1',
    envNames: [] as readonly string[],
    protocol: '本机 app-server · stdio',
  },
  doubaoTts: {
    name: '豆包 TTS',
    model: 'seed-audio-1.0',
    label: '音频生成 1.0',
    baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/create',
    envNames: ['DOUBAO_TTS_API_KEY', 'DOUBAO_API_KEY'],
    protocol: '音频生成 HTTP API',
  },
} as const;

export const baseUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .transform((s) => s.replace(/\/+$/, ''))
  .refine((s) => {
    try {
      const url = new URL(s);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  }, '接口地址须为 HTTPS，或本机 HTTP 地址，且不含账号、查询参数或片段。');

export const providerConfigSchema = z.object({
  model: z
    .string()
    .trim()
    .min(1, '请填写模型 ID。')
    .max(200)
    .regex(/^[a-zA-Z0-9._:/-]+$/, '模型 ID 格式无效。'),
  baseUrl: baseUrlSchema,
  credentialSource: z.enum(['environment', 'manual']),
  cliPath: z
    .string()
    .trim()
    .max(4096)
    .refine((s) => !/[\r\n\0]/.test(s), 'CLI 路径包含无效字符。')
    .optional(),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
const defaultCodexConfig = () => ({
  model: providers.codex.model,
  baseUrl: providers.codex.baseUrl,
  credentialSource: 'environment' as const,
});
const providerMap = <T extends z.ZodType>(schema: T) =>
  z.object({
    openai: schema,
    gemini: schema,
    deepseek: schema,
    minimax: schema,
    // Older settings files remain readable without rewriting or losing existing keys.
    codex: z.preprocess((value) => (value === undefined ? defaultCodexConfig() : value), schema),
    doubaoTts: z.preprocess(
      (value) => value ?? { ...providers.doubaoTts, credentialSource: 'environment' },
      schema,
    ),
  });
export const imageProviderSchema = z.enum(['codex', 'minimax']);
export type ImageProvider = z.infer<typeof imageProviderSchema>;
export const minimaxImageConcurrency = 5;

export const agentSettingsSchema = z.object({
  version: z.literal(1),
  defaultProvider: providerIdSchema,
  imageProvider: imageProviderSchema.default('codex'),
  providers: providerMap(providerConfigSchema),
});
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
const keyInput = z
  .string()
  .trim()
  .max(8192)
  .refine((s) => !/[\r\n\0]/.test(s), 'API Key 包含无效字符。')
  .optional();
export const providerDraftSchema = providerConfigSchema.extend({
  apiKey: keyInput,
  clearApiKey: z.boolean().optional(),
});
export type ProviderDraft = z.infer<typeof providerDraftSchema>;
export const saveAgentSettingsSchema = z.object({
  defaultProvider: providerIdSchema,
  imageProvider: imageProviderSchema.optional(),
  providers: providerMap(providerDraftSchema),
});
export type SaveAgentSettings = z.infer<typeof saveAgentSettingsSchema>;
export const testAgentConnectionSchema = z.object({
  provider: settingsProviderIdSchema,
  config: providerDraftSchema,
  audioPrompt: z.string().trim().min(1).max(3000).optional(),
});
export type TestAgentConnection = z.infer<typeof testAgentConnectionSchema>;
export interface CredentialStatus {
  environmentAvailable: boolean;
  environmentName: string;
  hasManualKey: boolean;
  manualKeyAvailable: boolean;
}
export interface AgentSettingsSnapshot extends AgentSettings {
  credentials: Record<SettingsProviderId, CredentialStatus>;
  secureStorageAvailable: boolean;
  desktop: boolean;
}
export interface ConnectionResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  audio?: { wavBase64: string; durationSeconds?: number };
}
export interface CodexModelOption {
  id: string;
  name: string;
}
export type CodexModelCatalog =
  { ok: true; models: CodexModelOption[] } | { ok: false; message: string };
export interface AgentSettingsAPI {
  get(): Promise<AgentSettingsSnapshot>;
  save(input: SaveAgentSettings): Promise<AgentSettingsSnapshot>;
  test(input: TestAgentConnection): Promise<ConnectionResult>;
  cancelConnectionTest(): Promise<void>;
  listCodexModels(cliPath: string): Promise<CodexModelCatalog>;
  findCodexPrograms(): Promise<string[]>;
  chooseCodexProgram(): Promise<string | null>;
}
export function defaultAgentSettings(): AgentSettings {
  return {
    version: 1,
    defaultProvider: 'openai',
    imageProvider: 'codex',
    providers: Object.fromEntries(
      settingsProviderIds.map((id) => [
        id,
        {
          model: providers[id].model,
          baseUrl: providers[id].baseUrl,
          credentialSource: 'environment',
        },
      ]),
    ) as AgentSettings['providers'],
  };
}

export const geminiSupportsThoughtSummaries = (model: string) =>
  /^gemini-(?:2\.5|[3-9]\d*)(?:[.-]|$)/i.test(model);

export function geminiGenerationConfig(
  model: string,
  maxOutputTokens: number,
  includeThoughts = false,
) {
  if (model === 'gemini-4-hydrogen')
    return {
      maxOutputTokens,
      thinkingConfig: {
        thinkingLevel: 'MEDIUM',
        ...(includeThoughts ? { includeThoughts: true } : {}),
      },
    };
  if (includeThoughts) {
    return {
      maxOutputTokens,
      thinkingConfig: {
        includeThoughts: true,
        // Use the lightest supported thinking level in the mode that displays summaries.
        ...(model === 'gemini-4-argon' ? { thinkingLevel: 'LOW' } : {}),
      },
    };
  }
  return {
    maxOutputTokens,
    // The configured Argon endpoint accepts a zero thinking budget. Other models may reject it.
    ...(model === 'gemini-4-argon' ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  };
}

// Only called in the desktop main process. Credentials never enter request URLs.
export function connectionRequest(provider: ProviderId, config: ProviderConfig, key: string) {
  if (provider === 'codex') throw new Error('Codex CLI 使用本机进程，不支持 HTTP 请求。');
  const base = config.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const prompt = 'Reply with OK only.';
  let url: string;
  let body: unknown;
  if (provider === 'gemini') {
    url = `${base}/models/${encodeURIComponent(config.model)}:generateContent`;
    headers['x-goog-api-key'] = key;
    body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: geminiGenerationConfig(config.model, 256),
    };
  } else {
    headers.Authorization = `Bearer ${key}`;
    if (provider === 'openai') {
      url = `${base}/responses`;
      body = {
        model: config.model,
        input: prompt,
        max_output_tokens: 256,
        reasoning: { effort: 'low' },
        store: false,
      };
    } else {
      url = `${base}/chat/completions`;
      body = {
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        ...(provider === 'deepseek'
          ? { max_tokens: 32, thinking: { type: 'disabled' } }
          : { max_tokens: 512, reasoning_effort: 'low' }),
      };
    }
  }
  return {
    url,
    init: { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error' as const },
  };
}
