import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AgentSettingsService, type SecretStorage } from '../../desktop/agent-settings';
import { voicePreviewWav } from '../fixtures/voice-preview';
import {
  baseUrlSchema,
  defaultAgentSettings,
  connectionRequest,
  providerIds,
  type SaveAgentSettings,
} from '../../packages/agent/settings';

// A reversible test codec verifies the storage boundary; production uses Electron safeStorage.
const secrets: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...s].reverse().join('')),
  decryptString: (s) => [...s.toString()].reverse().join(''),
};
const fixtureRoots: string[] = [];
afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) {
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('frameforge-agent-'))
      await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture(
  env: NodeJS.ProcessEnv = {},
  request: typeof fetch = fetch,
  vault = secrets,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-agent-'));
  fixtureRoots.push(root);
  return { root, service: new AgentSettingsService(root, vault, env, request) };
}
function draft(): SaveAgentSettings {
  const { defaultProvider, providers } = defaultAgentSettings();
  return { defaultProvider, providers };
}

describe('agent settings', () => {
  it('defaults legacy image settings to Codex and persists an independent MiniMax image selection', async () => {
    const { root, service } = await fixture({ MINIMAX_API_KEY: 'image-test-key' });
    const legacy = draft();
    await fs.writeFile(
      path.join(root, 'agent-settings.json'),
      JSON.stringify({ settings: { version: 1, ...legacy }, encryptedKeys: {} }),
    );
    expect((await service.get()).imageProvider).toBe('codex');
    await service.save({ ...legacy, imageProvider: 'minimax' });
    await service.save(legacy);
    const snapshot = await service.get();
    expect(snapshot).toMatchObject({ defaultProvider: 'openai', imageProvider: 'minimax' });
    expect(JSON.stringify(snapshot)).not.toContain('image-test-key');
    expect(await service.resolveImage()).toMatchObject({
      provider: 'minimax',
      apiKey: 'image-test-key',
    });
    expect(await service.resolveImage('codex')).toMatchObject({ provider: 'codex' });
  });

  it('migrates settings and tests Doubao WAV with environment and encrypted manual credentials', async () => {
    const wav = voicePreviewWav();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ audio: wav, duration: 0.1 }))
      .mockResolvedValueOnce(Response.json({ audio: wav }))
      .mockResolvedValueOnce(Response.json({ audio: Buffer.from('not WAV').toString('base64') }))
      .mockResolvedValueOnce(
        Response.json({ code: 45001001, message: 'manual-secret' }, { status: 403 }),
      );
    const env = { DOUBAO_TTS_API_KEY: 'speech-key', DOUBAO_API_KEY: 'fallback-key' };
    const { root, service } = await fixture(env, request);
    const legacy = defaultAgentSettings();
    const { doubaoTts, ...legacyProviders } = legacy.providers;
    await fs.writeFile(
      path.join(root, 'agent-settings.json'),
      JSON.stringify({
        settings: { ...legacy, defaultProvider: 'codex', providers: legacyProviders },
        encryptedKeys: {},
      }),
    );
    const snapshot = await service.get();
    expect(snapshot.defaultProvider).toBe('codex');
    expect(snapshot.credentials.doubaoTts.environmentName).toBe('DOUBAO_TTS_API_KEY');
    const audioPrompt = '你好，帧叙。';
    const input = {
      provider: 'doubaoTts' as const,
      config: snapshot.providers.doubaoTts,
      audioPrompt,
    };
    expect(await service.test(input)).toMatchObject({
      ok: true,
      audio: { wavBase64: wav, durationSeconds: 0.1 },
    });
    expect(request.mock.calls[0]?.[0]).toBe('https://openspeech.bytedance.com/api/v3/tts/create');
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'X-Api-Key': 'speech-key' },
      redirect: 'error',
    });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'seed-audio-1.0',
      text_prompt: audioPrompt,
      audio_config: { format: 'wav', sample_rate: 24000 },
    });
    const saveInput = { defaultProvider: snapshot.defaultProvider, providers: snapshot.providers };
    await service.save({
      ...saveInput,
      providers: {
        ...saveInput.providers,
        doubaoTts: {
          ...doubaoTts,
          credentialSource: 'manual',
          apiKey: 'manual-secret',
        },
      },
    });
    const restarted = new AgentSettingsService(
      root,
      secrets,
      { DOUBAO_API_KEY: 'fallback-key' },
      request,
    );
    const restored = await restarted.get();
    expect(restored.credentials.doubaoTts).toMatchObject({
      manualKeyAvailable: true,
      environmentName: 'DOUBAO_API_KEY',
    });
    expect(await fs.readFile(path.join(root, 'agent-settings.json'), 'utf8')).not.toContain(
      'manual-secret',
    );
    const manual = { ...input, config: restored.providers.doubaoTts };
    expect((await restarted.test(manual)).ok).toBe(true);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ headers: { 'X-Api-Key': 'manual-secret' } });
    expect(await restarted.test(manual)).toMatchObject({
      ok: false,
      message: expect.stringContaining('可播放的 WAV'),
    });
    const rejected = await restarted.test(manual);
    expect(rejected).toMatchObject({ ok: false, message: expect.stringContaining('HTTP 403') });
    expect(rejected.message).not.toContain('manual-secret');
  });

  it('reports credentials without exposing environment values and supports the Google alias', async () => {
    const { service } = await fixture({
      OPENAI_API_KEY: 'secret-env-value',
      GOOGLE_API_KEY: 'google-secret',
    });
    const snapshot = await service.get();
    expect(snapshot.defaultProvider).toBe('openai');
    expect(snapshot.credentials.openai.environmentAvailable).toBe(true);
    expect(snapshot.credentials.gemini.environmentName).toBe('GOOGLE_API_KEY');
    expect(snapshot.credentials.deepseek.environmentAvailable).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('secret-env-value');
    expect(JSON.stringify(snapshot)).not.toContain('google-secret');
  });
  it('persists encrypted manual keys, preserves blank keys, switches sources, and removes keys', async () => {
    const requests = vi.fn<typeof fetch>(async () =>
      Response.json({ status: 'completed', output: [] }),
    );
    const { service, root } = await fixture({ OPENAI_API_KEY: 'environment-key' }, requests);
    const input = draft();
    input.defaultProvider = 'minimax';
    input.providers.openai = {
      ...input.providers.openai,
      credentialSource: 'manual',
      apiKey: 'manual-secret',
    };
    const saved = await service.save(input);
    expect(saved.credentials.openai.manualKeyAvailable).toBe(true);
    const stored = await fs.readFile(path.join(root, 'agent-settings.json'), 'utf8');
    expect(stored).not.toContain('manual-secret');
    expect(stored).not.toContain('environment-key');
    expect(JSON.stringify(saved)).not.toContain('manual-secret');
    const restarted = new AgentSettingsService(
      root,
      secrets,
      { OPENAI_API_KEY: 'environment-key' },
      requests,
    );
    expect((await restarted.get()).defaultProvider).toBe('minimax');
    const blank = draft();
    blank.providers.openai.credentialSource = 'manual';
    await restarted.save(blank);
    expect((await restarted.test({ provider: 'openai', config: blank.providers.openai })).ok).toBe(
      true,
    );
    expect(requests.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer manual-secret' },
    });
    await restarted.test({
      provider: 'openai',
      config: { ...blank.providers.openai, credentialSource: 'environment' },
    });
    expect(requests.mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer environment-key' },
    });
    blank.providers.openai.clearApiKey = true;
    expect((await restarted.save(blank)).credentials.openai.hasManualKey).toBe(false);
    expect((await restarted.test({ provider: 'openai', config: blank.providers.openai })).ok).toBe(
      false,
    );
    expect(requests).toHaveBeenCalledTimes(2);
  });
  it('tests unsaved keys and addresses without persisting them', async () => {
    const requests = vi.fn<typeof fetch>(async () =>
      Response.json({ choices: [{ message: { content: 'OK' } }] }),
    );
    const { service, root } = await fixture({}, requests);
    const config = {
      ...draft().providers.deepseek,
      credentialSource: 'manual' as const,
      apiKey: 'temporary-secret',
      baseUrl: 'http://127.0.0.1:1234/v1',
    };
    expect((await service.test({ provider: 'deepseek', config })).ok).toBe(true);
    expect(requests.mock.calls[0]?.[0]).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(await fs.readdir(root)).toEqual([]);
    expect((await service.get()).credentials.deepseek.hasManualKey).toBe(false);
  });
  it('refuses plaintext persistence when OS encryption is unavailable', async () => {
    const { service, root } = await fixture({}, fetch, {
      ...secrets,
      isEncryptionAvailable: () => false,
    });
    const input = draft();
    input.providers.minimax.apiKey = 'sensitive-key';
    await expect(service.save(input)).rejects.toThrow('系统密钥加密不可用');
    expect(await fs.readdir(root)).toEqual([]);
    delete input.providers.minimax.apiKey;
    await expect(service.save(input)).resolves.toBeDefined();
  });
  it('keeps corrupt configuration untouched', async () => {
    const { root, service } = await fixture();
    const file = path.join(root, 'agent-settings.json');
    await fs.writeFile(file, '{broken');
    await expect(service.get()).rejects.toThrow('原文件已保留');
    await expect(service.save(draft())).rejects.toThrow('原文件已保留');
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  });
  it('redacts vendor error bodies and rejects incompatible success responses', async () => {
    const requests = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Authorization: Bearer TOP_SECRET', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ error: { message: 'TOP_SECRET' } }))
      .mockResolvedValueOnce(Response.json({ hello: 'world' }));
    const { service } = await fixture({ OPENAI_API_KEY: 'TOP_SECRET' }, requests);
    const input = { provider: 'openai' as const, config: draft().providers.openai };
    for (let i = 0; i < 3; i++) {
      const result = await service.test(input);
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain('TOP_SECRET');
    }
  });
  it('aborts slow tests and releases the test lock', async () => {
    const requests = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const { service } = await fixture({ OPENAI_API_KEY: 'key' }, requests);
    vi.useFakeTimers();
    try {
      const input = { provider: 'openai' as const, config: draft().providers.openai };
      const pending = service.test(input);
      // The file read must settle before advancing the timer.
      await vi.waitFor(() => expect(requests).toHaveBeenCalled());
      expect((await service.test(input)).message).toContain('正在进行');
      await vi.advanceTimersByTimeAsync(25000);
      expect((await pending).message).toContain('超时');
    } finally {
      vi.useRealTimers();
    }
  });
  it('explains exhausted credits and unsupported regions without exposing vendor messages', async () => {
    const requests = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'credit_balance_exhausted', message: 'SECRET' } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              status: 'FAILED_PRECONDITION',
              message: 'User location is not supported. SECRET',
            },
          },
          { status: 400 },
        ),
      );
    const { service } = await fixture({ OPENAI_API_KEY: 'key', GEMINI_API_KEY: 'key' }, requests);
    const quota = await service.test({ provider: 'openai', config: draft().providers.openai });
    expect(quota.message).toContain('余额或额度已用尽');
    const region = await service.test({ provider: 'gemini', config: draft().providers.gemini });
    expect(region.message).toContain('地区不受该服务支持');
    expect(JSON.stringify([quota, region])).not.toContain('SECRET');
  });
});

describe('provider requests', () => {
  it('uses the provider protocols, correct default models, and no credentials in URLs', () => {
    const configs = defaultAgentSettings().providers;
    for (const id of providerIds) {
      if (id === 'codex') {
        expect(() => connectionRequest(id, configs[id], 'a-secret')).toThrow('本机进程');
        continue;
      }
      const request = connectionRequest(id, configs[id], 'a-secret');
      expect(request.url).not.toContain('a-secret');
      expect(request.init.redirect).toBe('error');
      const body = JSON.parse(request.init.body);
      if (id === 'gemini') {
        expect(request.url).toBe(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent',
        );
        expect(request.init.headers['x-goog-api-key']).toBe('a-secret');
        expect(body.generationConfig).toEqual({
          maxOutputTokens: 256,
          thinkingConfig: { thinkingLevel: 'MEDIUM' },
        });
      } else {
        expect(body.model).toBe(configs[id].model);
        expect(request.init.headers.Authorization).toBe('Bearer a-secret');
      }
      if (id === 'openai') {
        expect(request.url).toMatch(/\/responses$/);
        expect(body.store).toBe(false);
      }
    }
  });
  it('only permits secure endpoints and local HTTP, without URL credentials or query strings', () => {
    expect(baseUrlSchema.parse(' https://api.minimax.io/v1/ ')).toBe('https://api.minimax.io/v1');
    expect(baseUrlSchema.safeParse('http://localhost:8080/v1').success).toBe(true);
    for (const value of [
      'http://example.com',
      'https://key@example.com/v1',
      'https://api.openai.com/v1?key=secret',
      'file:///secret',
      'https://api.openai.com/#key',
    ])
      expect(baseUrlSchema.safeParse(value).success).toBe(false);
  });
});
