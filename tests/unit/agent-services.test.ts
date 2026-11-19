import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentSessionService } from '../../desktop/agent-sessions';
import { AgentModelService } from '../../desktop/agent-model';
import { AgentSettingsService, type SecretStorage } from '../../desktop/agent-settings';
import { newSession, type ModelRequest } from '../../packages/agent/types';
import { defaultAgentSettings } from '../../packages/agent/settings';

const encode = new TextEncoder();
const geminiEvent = (parts: object[], finishReason?: string) =>
  `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason }] })}\r\n\r\n`;

const secrets: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...s].reverse().join('')),
  decryptString: (b) => [...b.toString()].reverse().join(''),
};
const request = (runId = 'test'): ModelRequest => ({
  runId,
  provider: 'deepseek',
  system: 'system',
  messages: [{ role: 'user', content: 'test' }],
  tools: [],
  exchanges: [],
  maxOutputTokens: 4096,
});
describe('agent session persistence', () => {
  it.runIf(process.platform === 'win32')(
    'retries a transient Windows replacement failure',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-chat-'));
      const session = newSession('project_retry');
      const service = new AgentSessionService(root);
      const rename = vi.spyOn(fs, 'rename');
      try {
        await service.save(session);
        rename.mockClear();
        rename.mockRejectedValueOnce(
          Object.assign(new Error('file temporarily locked'), { code: 'EPERM' }),
        );
        session.title = '已完成首帧';
        await service.save(session);
        expect(rename).toHaveBeenCalledTimes(2);
        expect((await service.load(session.projectId, session.id))?.title).toBe(session.title);
      } finally {
        rename.mockRestore();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it('isolates projects, saves atomically, survives reload and does not serialize provider frames', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-chat-'));
    const service = new AgentSessionService(root);
    const a = newSession('project_a');
    a.title = '对话 A';
    a.memory.summary = '创作记忆';
    const b = newSession('project_b');
    b.title = '对话 B';
    const draft = {
      target: { stage: 'outline' } as const,
      request: '选 A',
      text: '第一章从渡口开始。',
      updatedAt: new Date().toISOString(),
    };
    await Promise.all([
      service.save(a),
      service.save(b),
      service.saveCreativeDraft(a.projectId, draft),
    ]);
    const restarted = new AgentSessionService(root);
    expect((await restarted.list('project_a')).map((s) => s.title)).toEqual(['对话 A']);
    expect((await restarted.load('project_a', a.id))?.memory.summary).toBe('创作记忆');
    expect(await restarted.load('project_a', b.id)).toBeNull();
    expect(await restarted.loadCreativeDraft(a.projectId)).toEqual(draft);
    expect(await restarted.loadCreativeDraft(b.projectId)).toBeNull();
    await expect(restarted.load('project_a', '../other')).rejects.toThrow('ID');
    await restarted.delete('project_a', a.id);
    expect(await restarted.list('project_a')).toEqual([]);
    expect(await restarted.loadCreativeDraft(a.projectId)).toEqual(draft);
    expect(await restarted.list('project_b')).toHaveLength(1);
  });
});
describe('main-process model service', () => {
  function geminiService(fetcher: typeof fetch, model?: string) {
    const settings = new AgentSettingsService(os.tmpdir(), secrets);
    const config = defaultAgentSettings().providers.gemini;
    vi.spyOn(settings, 'resolveModel').mockResolvedValue({
      provider: 'gemini',
      config: { ...config, model: model ?? config.model },
      apiKey: 'test-key',
    });
    return new AgentModelService(settings, fetcher);
  }

  it('streams thought summaries separately from the answer and replays signed tool parts and IDs', async () => {
    const summaryPart = { text: '先核对故事。', thought: true };
    const publicPart = { text: '第一段' };
    const toolPart = {
      functionCall: { name: 'read_project', args: {}, id: 'c1' },
      thoughtSignature: 'signed',
    };
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream({
        start: (controller) => {
          stream = controller;
        },
      }),
      {
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      },
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(
        Response.json({
          candidates: [{ content: { parts: [{ text: '完成' }] }, finishReason: 'STOP' }],
        }),
      );
    const service = geminiService(fetcher, 'gemini-4-argon');
    const input = { ...request(), provider: 'gemini' as const };
    const onDelta = vi.fn();
    const complete = vi.fn();
    const pending = service.complete(input, onDelta).then((frame) => {
      complete();
      return frame;
    });
    // Split every byte, including UTF-8 characters and CRLF separators.
    for (const byte of encode.encode(geminiEvent([summaryPart, publicPart])))
      stream.enqueue(Uint8Array.of(byte));
    await vi.waitFor(() =>
      expect(onDelta).toHaveBeenNthCalledWith(2, { kind: 'text', text: '第一段' }),
    );
    expect(complete).not.toHaveBeenCalled();
    stream.enqueue(encode.encode(geminiEvent([{ text: '接着写。' }, toolPart], 'STOP')));
    stream.enqueue(
      encode.encode(
        'data: {"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":10}}\r\n\r\n',
      ),
    );
    stream.close();
    const frame = await pending;
    expect(frame).toMatchObject({
      text: '第一段接着写。',
      calls: [{ name: 'read_project', id: 'c1', arguments: '{}' }],
      usage: { input: 20, output: 10 },
    });
    expect(onDelta.mock.calls.flat()).toEqual([
      { kind: 'thoughtSummary', text: '先核对故事。' },
      { kind: 'text', text: '第一段' },
      { kind: 'text', text: '接着写。' },
    ]);
    expect(fetcher.mock.calls[0][0]).toContain(':streamGenerateContent?alt=sse');
    expect(
      JSON.parse(fetcher.mock.calls[0][1]!.body as string).generationConfig.thinkingConfig,
    ).toEqual({ includeThoughts: true, thinkingLevel: 'LOW' });
    await service.complete({
      ...input,
      exchanges: [
        { frame, replies: [{ call: frame.calls[0], result: { ok: true, summary: '已读' } }] },
      ],
    });
    const body = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
    expect(body.contents[1].parts).toEqual([
      summaryPart,
      publicPart,
      { text: '接着写。' },
      toolPart,
    ]);
    expect(body.contents[2].parts[0].functionResponse).toMatchObject({
      id: 'c1',
      name: 'read_project',
    });
  });

  it('resets the Gemini idle deadline for active streams and can continue after a stalled batch', async () => {
    vi.useFakeTimers();
    try {
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const cancel = vi.fn();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream({
              start: (controller) => {
                stream = controller;
              },
              cancel,
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({
            candidates: [{ content: { parts: [{ text: '已继续' }] }, finishReason: 'STOP' }],
          }),
        );
      const service = geminiService(fetcher);
      const input = { ...request(), provider: 'gemini' as const };
      const pending = service.complete(input);
      await vi.advanceTimersByTimeAsync(10_000);
      stream.enqueue(
        encode.encode(geminiEvent([{ functionCall: { name: 'edit_scene', args: {} } }])),
      );
      await vi.advanceTimersByTimeAsync(170_000);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toMatchObject({
        finish: 'invalid',
        calls: [],
        raw: null,
        issue: expect.stringContaining('180 秒'),
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(await service.complete(input)).toMatchObject({ finish: 'complete', text: '已继续' });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['premature close', 'MAX_TOKENS', 'cancel'])(
    'never hands an unfinished Gemini batch to the editor on %s',
    async (ending) => {
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream({
          start: (controller) => {
            stream = controller;
          },
          cancel,
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
      const service = geminiService(async () => response);
      const onText = vi.fn();
      const pending = service.complete({ ...request(), provider: 'gemini' }, onText);
      stream.enqueue(
        encode.encode(
          geminiEvent([
            { text: '草稿' },
            { functionCall: { name: 'edit_scene', id: 'not-ready', args: {} } },
          ]),
        ),
      );
      await vi.waitFor(() => expect(onText).toHaveBeenCalled());
      if (ending === 'cancel') {
        const stopped = expect(pending).rejects.toThrow('已经停止');
        service.cancel('test');
        await stopped;
        expect(cancel).toHaveBeenCalledOnce();
        return;
      }
      if (ending === 'MAX_TOKENS') stream.enqueue(encode.encode(geminiEvent([], ending)));
      stream.close();
      expect(await pending).toMatchObject({
        finish: ending === 'MAX_TOKENS' ? 'length' : 'invalid',
        text: '',
        calls: [],
        raw: null,
      });
    },
  );

  it('keeps Hydrogen at MEDIUM when the relay rejects streaming and the run falls back to unary', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({}, { status: 405 }))
      .mockImplementation(async () =>
        Response.json({
          candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
        }),
      );
    const service = geminiService(fetcher, 'gemini-4-hydrogen');
    const input = { ...request(), provider: 'gemini' as const };
    expect(await service.complete(input, vi.fn())).toMatchObject({ text: 'OK' });
    await service.complete(input);
    expect(fetcher.mock.calls.map(([url]) => String(url).split(':').at(-1))).toEqual([
      'streamGenerateContent?alt=sse',
      'generateContent',
      'generateContent',
    ]);
    expect(
      fetcher.mock.calls.map(
        ([, init]) => JSON.parse(init!.body as string).generationConfig.thinkingConfig,
      ),
    ).toEqual([
      { thinkingLevel: 'MEDIUM', includeThoughts: true },
      { thinkingLevel: 'MEDIUM' },
      { thinkingLevel: 'MEDIUM' },
    ]);
  });

  it.each([
    ['openai', ['max_output_tokens'], { status: 'completed', output: [] }],
    [
      'gemini',
      ['generationConfig', 'maxOutputTokens'],
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
      },
    ],
    [
      'deepseek',
      ['max_tokens'],
      { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] },
    ],
    [
      'minimax',
      ['max_tokens'],
      { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] },
    ],
  ] as const)(
    'sends a 40,960-token output budget through %s',
    async (provider, outputField, reply) => {
      const settings = new AgentSettingsService(os.tmpdir(), secrets);
      vi.spyOn(settings, 'resolveModel').mockResolvedValue({
        provider,
        config: defaultAgentSettings().providers[provider],
        apiKey: 'test-key',
      });
      const fetcher = vi.fn<typeof fetch>(async () => Response.json(reply));
      const service = new AgentModelService(settings, fetcher);

      await service.complete({ ...request(), provider, maxOutputTokens: 40_960 });

      const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
      if (provider === 'deepseek') {
        expect(body).toMatchObject({
          thinking: { type: 'enabled' },
          reasoning_effort: 'low',
        });
      }
      let field = body;
      for (const key of outputField) field = field[key];
      expect(field).toBe(40_960);
    },
  );

  it('accepts the Gemini relay retry after a first attempt times out at 55 seconds', async () => {
    vi.useFakeTimers();
    try {
      const settings = new AgentSettingsService(os.tmpdir(), secrets);
      vi.spyOn(settings, 'resolveModel').mockResolvedValue({
        provider: 'gemini',
        config: defaultAgentSettings().providers.gemini,
        apiKey: 'test-key',
      });
      const replyAfter =
        (delay: number, response: Response): typeof fetch =>
        (_url, init) =>
          new Promise((resolve, reject) => {
            const signal = init?.signal;
            const abort = () => {
              clearTimeout(timer);
              reject(signal?.reason);
            };
            const timer = setTimeout(() => {
              signal?.removeEventListener('abort', abort);
              resolve(response);
            }, delay);
            signal?.addEventListener('abort', abort, { once: true });
          });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(replyAfter(55_000, Response.json({ error: {} }, { status: 504 })))
        .mockImplementationOnce(
          replyAfter(
            52_000,
            Response.json({
              candidates: [
                { content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' },
              ],
            }),
          ),
        );
      const service = new AgentModelService(settings, fetcher);
      const pending = service.complete({ ...request(), provider: 'gemini' });
      const assertion = expect(pending).resolves.toMatchObject({ text: 'OK' });
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(55_000);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(52_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns exhausted Gemini connection attempts to the host as retryable without partial calls', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network failure'))
      .mockRejectedValueOnce(new TypeError('network failure'))
      .mockResolvedValueOnce(
        Response.json({
          candidates: [{ content: { parts: [{ text: '已继续' }] }, finishReason: 'STOP' }],
        }),
      );
    const service = geminiService(fetcher);
    const input = { ...request(), provider: 'gemini' as const };
    await expect(service.complete(input)).resolves.toMatchObject({
      finish: 'invalid',
      issue: 'Gemini 网络连接未建立。',
      text: '',
      calls: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(service.complete(input)).resolves.toMatchObject({
      finish: 'complete',
      text: '已继续',
    });
  });

  it('freezes model settings for a run and keeps credentials outside return values', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-model-'));
    const settings = new AgentSettingsService(root, secrets, { DEEPSEEK_API_KEY: 'SECRET' });
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      }),
    );
    const service = new AgentModelService(settings, fetcher);
    const first = await service.complete(request());
    const { defaultProvider, providers } = defaultAgentSettings();
    providers.deepseek.model = 'custom-flash';
    await settings.save({ defaultProvider, providers });
    await service.complete(request());
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).model).toBe('deepseek-v4-flash');
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).model).toBe('deepseek-v4-flash');
    expect(JSON.stringify(first)).not.toContain('SECRET');
    service.cancel('test');
    await expect(service.complete(request())).rejects.toThrow('已经停止');
    await service.complete(request('next'));
    expect(JSON.parse(fetcher.mock.calls[2][1]!.body as string).model).toBe('custom-flash');
    service.cancelAll();
  });
  it('aborts active network requests and never exposes raw vendor error messages', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-model-'));
    const settings = new AgentSettingsService(root, secrets, { DEEPSEEK_API_KEY: 'SECRET' });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ error: { message: 'Authorization: SECRET' } }, { status: 401 }),
      )
      .mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('SECRET'))),
          ),
      );
    const service = new AgentModelService(settings, fetcher);
    await expect(service.complete(request('error'))).rejects.toThrow('API Key');
    service.cancel('error');
    const pending = service.complete(request('cancel'));
    const assertion = expect(pending).rejects.toThrow('停止');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    service.cancel('cancel');
    await assertion;
  });
});
