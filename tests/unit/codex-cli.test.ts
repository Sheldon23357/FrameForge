import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CodexCliSession,
  findCodexPrograms,
  launchCodex,
  resolveCodexCommand,
  type CodexLauncher,
} from '../../desktop/codex-cli';
import { AgentModelService } from '../../desktop/agent-model';
import { createCodexAudio } from '../../desktop/codex-audio';
import { AgentSettingsService } from '../../desktop/agent-settings';
import { agentSettingsSchema, defaultAgentSettings } from '../../packages/agent/settings';
import { newSession, type ModelRequest } from '../../packages/agent/types';
import type { HarnessOptions } from '../../packages/agent/harness';
import { runHarness as runAgent } from '../fixtures/agent-intent';
import { createEditorTools } from '../../packages/agent/tools';
import { testProject } from '../fixtures/project';

const fixture = path.resolve('tests/fixtures/fake-codex-cli.mjs');
const roots: string[] = [];
const sessions: CodexCliSession[] = [];
const models: AgentModelService[] = [];

it('repairs an overlong note before saving a short BGM', async () => {
  const makeFrame = (durationMs: number) => ({
    text: JSON.stringify({
      notes: [{ startMs: 0, durationMs, wave: 'pluck', hz: 440, gain: 0.3 }],
    }),
    calls: [],
    raw: {},
    finish: 'complete' as const,
  });
  const complete = vi
    .spyOn(CodexCliSession.prototype, 'complete')
    .mockResolvedValueOnce(makeFrame(300))
    .mockImplementationOnce(async (_config, request) => {
      expect(request.messages[0].content).toContain('notes.0 结束于 300ms，超过请求的 120ms');
      return makeFrame(100);
    });
  try {
    const wav = await createCodexAudio(
      defaultAgentSettings().providers.codex,
      { category: 'music', name: '悬念', prompt: '低音弦乐铺底。', durationMs: 120 },
      new AbortController().signal,
    );
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.length).toBe(44 + 120 * 24 * 2);
    expect(complete).toHaveBeenCalledTimes(2);
  } finally {
    complete.mockRestore();
  }
});
async function setup(scenario = 'text') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frameforge-codex-'));
  roots.push(root);
  const log = path.join(root, 'rpc.jsonl');
  const launch: CodexLauncher = vi.fn(async () =>
    spawn(process.execPath, [fixture], {
      env: { ...process.env, FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_LOG: log },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }),
  );
  const session = new CodexCliSession(launch);
  sessions.push(session);
  const settings = new AgentSettingsService(
    root,
    {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw Error('unused');
      },
      decryptString: () => {
        throw Error('unused');
      },
    },
    {},
    vi.fn(),
    launch,
  );
  const model = new AgentModelService(settings, vi.fn(), launch);
  models.push(model);
  return { root, log, launch, session, settings, model };
}
const request = (): ModelRequest => ({
  runId: 'codex-test',
  provider: 'codex',
  system: '创作系统指令',
  messages: [
    { role: 'assistant', content: '历史消息' },
    { role: 'user', content: '修改当前节点' },
  ],
  tools: createEditorTools()
    .specs()
    .filter((tool) => tool.name !== 'set_task_scope'),
  exchanges: [],
  maxOutputTokens: 4096,
});
afterEach(async () => {
  for (const model of models.splice(0)) model.cancelAll();
  for (const session of sessions.splice(0)) session.close();
  // Child handles can close a moment after kill on Windows.
  for (const root of roots.splice(0))
    // Only fixture directories created by mkdtemp above may be removed recursively.
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('frameforge-codex-'))
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe('Codex CLI provider', () => {
  it('reads all visible model pages without starting a conversation and reports a signed-out CLI', async () => {
    const { settings, log } = await setup();
    expect(await settings.listCodexModels('')).toEqual({
      ok: true,
      models: [
        { id: 'fixture-fast', name: 'Fixture Fast' },
        { id: 'fixture-deep', name: 'Fixture Deep' },
      ],
    });
    const calls = (await fs.readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => call.method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'model/list',
      'model/list',
    ]);
    expect(calls[4].params).toMatchObject({ cursor: 'next', includeHidden: false });
    const signedOut = await setup('logged-out');
    expect(await signedOut.settings.listCodexModels('')).toMatchObject({
      ok: false,
      message: expect.stringContaining('尚未登录'),
    });
  });

  it('migrates old settings, resolves without API keys, and ignores CLI key inputs', async () => {
    const { settings, root } = await setup();
    const legacy = defaultAgentSettings();
    delete (legacy.providers as Partial<typeof legacy.providers>).codex;
    expect(agentSettingsSchema.parse(legacy).providers.codex.model).toBe('default');
    await fs.writeFile(
      path.join(root, 'agent-settings.json'),
      JSON.stringify({ settings: legacy, encryptedKeys: {} }),
    );
    const input = { ...defaultAgentSettings(), defaultProvider: 'codex' as const };
    const saved = await settings.save({
      ...input,
      providers: { ...input.providers, codex: { ...input.providers.codex, apiKey: 'DO_NOT_SAVE' } },
    });
    expect(saved.defaultProvider).toBe('codex');
    expect((await settings.resolveModel('codex')).apiKey).toBe('');
    expect(await fs.readFile(path.join(root, 'agent-settings.json'), 'utf8')).not.toContain(
      'DO_NOT_SAVE',
    );
  });

  it('performs a real stdio handshake, hides reasoning, and tests model access', async () => {
    const { settings, log } = await setup();
    expect(
      await settings.test({ provider: 'codex', config: defaultAgentSettings().providers.codex }),
    ).toMatchObject({ ok: true });
    const rpc = (await fs.readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rpc[0].params.capabilities.experimentalApi).toBe(true);
    const thread = rpc.find((m) => m.method === 'thread/start').params;
    expect(thread).toMatchObject({
      ephemeral: true,
      environments: [],
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    expect(thread.model).toBeUndefined();
    expect(thread.dynamicTools).toEqual([]);
  });

  it('executes registered editor tools and commits the whole run once', async () => {
    const { model, log, launch } = await setup('tools');
    const project = testProject();
    const commit = vi.fn<HarnessOptions['commit']>(() => true);
    const result = await runAgent({
      session: newSession(project.id),
      user: '修改当前节点标题',
      plan: { kind: 'execute' },
      provider: 'codex',
      model: 'default',
      project,
      selectedIds: ['scene_intro'],
      activeChapterId: null,
      registry: createEditorTools(),
      client: (input) => model.complete(input),
      signal: new AbortController().signal,
      runId: 'tool-run',
      commit,
      onEvent: () => {},
    });
    expect(result.turn.status).toBe('completed');
    expect(result.turn.committed).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][1].scenes.find((s) => s.id === 'scene_intro')!.title).toBe(
      'CLI 第一处修改',
    );
    expect(project.scenes.find((s) => s.id === 'scene_intro')!.title).not.toContain('CLI');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(launch).toHaveBeenCalledTimes(1);
    const rpc = (await fs.readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      rpc.filter((m) => m.method === 'thread/start').at(-1).params.dynamicTools,
    ).toContainEqual(expect.objectContaining({ name: 'edit_scene' }));
    expect(rpc.find((m) => m.id === 'rpc-1' && m.result).result).toMatchObject({
      success: true,
      contentItems: [{ type: 'inputText', text: expect.stringContaining('true') }],
    });
  });

  it('refreshes the tool catalog between host stages and handles repeated provider call IDs', async () => {
    const { model, log, launch } = await setup('multistage');
    const project = testProject();
    const commit = vi.fn<HarnessOptions['commit']>(() => true);
    const result = await runAgent({
      session: newSession(project.id),
      user: '保存简报再写当前节点剧本',
      plan: { kind: 'execute', design: { brief: true }, screenplay: { scope: 'selected' } },
      provider: 'codex',
      model: 'default',
      project,
      selectedIds: ['scene_intro'],
      activeChapterId: null,
      registry: createEditorTools(),
      client: (input) => model.complete(input),
      signal: AbortSignal.timeout(10000),
      runId: 'multistage-run',
      commit,
      onEvent: () => {},
    });
    expect(result.turn.status, result.turn.error).toBe('completed');
    expect(launch).toHaveBeenCalledTimes(2);
    const candidate = commit.mock.lastCall![1];
    expect(candidate.storyDesign?.brief?.text).toBe('测试工程简报。');
    expect(candidate.screenplays?.[0].blocks).toEqual([{ kind: 'action', text: '主角拆开来信。' }]);
    const tools = (await fs.readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter(({ method }) => method === 'thread/start')
      .map(({ params }) => params.dynamicTools.map(({ name }: { name: string }) => name));
    expect(tools[0]).toContain('edit_story_design');
    expect(tools[0]).not.toContain('edit_screenplay');
    expect(tools[1]).toContain('edit_screenplay');
  });

  it('queues parallel calls, continues validation feedback, and starts fresh for compaction', async () => {
    const { model, launch } = await setup('parallel');
    const input = request();
    const first = await model.complete(input);
    input.exchanges.push({
      frame: first,
      replies: [{ call: first.calls[0], result: { ok: true, summary: 'first' } }],
    });
    const second = await model.complete(input);
    expect(second.calls[0].id).toBe('call-2');
    input.exchanges.push({
      frame: second,
      replies: [{ call: second.calls[0], result: { ok: true, summary: 'second' } }],
    });
    const final = await model.complete(input);
    expect(final.text).toBe('已完成本机创作。');
    input.exchanges.push({ frame: final, replies: [], feedback: '请修复校验错误' });
    expect((await model.complete(input)).calls).toEqual([]);
    expect(launch).toHaveBeenCalledTimes(1);
    await model.complete(request());
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it.each(['logged-out', 'bad-json', 'rpc-error', 'exit', 'failed', 'unknown-tool'])(
    'reports %s without exposing raw diagnostics',
    async (scenario) => {
      const { model } = await setup(scenario);
      const error = await model.complete(request()).catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('SECRET');
      if (scenario === 'logged-out') expect((error as Error).message).toContain('codex login');
    },
  );

  it('cancels a waiting model and preserves the ended-run guard', async () => {
    const { model, log } = await setup('hang');
    const pending = model.complete(request());
    const assertion = expect(pending).rejects.toThrow('停止');
    await vi.waitFor(async () => expect(await fs.readFile(log, 'utf8')).toContain('turn/start'));
    model.cancel('codex-test');
    await assertion;
    await expect(model.complete(request())).rejects.toThrow('已经停止');
  });

  it('returns tool errors to Codex for repair before one atomic commit', async () => {
    const { model, log } = await setup('tool-error');
    const project = testProject();
    const commit = vi.fn<HarnessOptions['commit']>(() => true);
    const { turn } = await runAgent({
      session: newSession(project.id),
      user: '修改选中节点标题',
      plan: { kind: 'execute' },
      provider: 'codex',
      model: 'default',
      project,
      selectedIds: ['scene_intro'],
      activeChapterId: null,
      registry: createEditorTools(),
      client: (input) => model.complete(input),
      signal: new AbortController().signal,
      runId: 'repair',
      commit,
      onEvent: () => {},
    });
    expect(turn.status).toBe('completed');
    expect(turn.traces.map((trace) => trace.status)).toEqual(['error', 'done']);
    expect(commit).toHaveBeenCalledTimes(1);
    const rpc = (await fs.readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rpc.find((m) => m.id === 'rpc-1' && m.result).result.success).toBe(false);
  });

  it('discards an edited copy when the CLI is stopped while continuing', async () => {
    const { model, log } = await setup('tools-hang');
    const project = testProject();
    const before = structuredClone(project);
    const controller = new AbortController();
    controller.signal.addEventListener('abort', () => model.cancel('stop-copy'));
    const commit = vi.fn<HarnessOptions['commit']>(() => true);
    const pending = runAgent({
      session: newSession(project.id),
      user: '修改选中节点标题',
      plan: { kind: 'execute' },
      provider: 'codex',
      model: 'default',
      project,
      selectedIds: ['scene_intro'],
      activeChapterId: null,
      registry: createEditorTools(),
      client: (input) => model.complete(input),
      signal: controller.signal,
      runId: 'stop-copy',
      commit,
      onEvent: () => {},
    });
    await vi.waitFor(async () => expect(await fs.readFile(log, 'utf8')).toContain('contentItems'));
    controller.abort();
    expect((await pending).turn.status).toBe('stopped');
    expect(commit).not.toHaveBeenCalled();
    expect(project).toEqual(before);
  });

  it('times out stalled CLI requests and releases the connection-test lock', async () => {
    const { model, settings, log } = await setup('hang');
    vi.useFakeTimers();
    try {
      const settled = vi.fn();
      const pending = model.complete(request()).finally(settled);
      const assertion = expect(pending).rejects.toThrow('等待下一步响应超时（180 秒）');
      await vi.waitFor(async () => expect(await fs.readFile(log, 'utf8')).toContain('turn/start'));
      await vi.advanceTimersByTimeAsync(90_000);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(90_000);
      await assertion;
      const input = { provider: 'codex' as const, config: defaultAgentSettings().providers.codex };
      await fs.writeFile(log, '');
      const test = settings.test(input);
      await vi.waitFor(async () => expect(await fs.readFile(log, 'utf8')).toContain('turn/start'));
      expect((await settings.test(input)).message).toContain('正在进行');
      await vi.advanceTimersByTimeAsync(25000);
      expect(await test).toMatchObject({ ok: false, message: expect.stringContaining('超时') });
      const retry = settings.test(input);
      settings.cancelTest();
      expect((await retry).message).not.toContain('正在进行');
    } finally {
      vi.useRealTimers();
    }
  });

  it('locates programs with spaces, searches PATH and common install locations without running them', async () => {
    const { root } = await setup();
    const bin = path.join(root, 'npm with spaces');
    await fs.mkdir(bin);
    const program = path.join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex');
    await fs.writeFile(program, 'not executed during discovery');
    expect(
      await findCodexPrograms(
        { PATH: bin, USERPROFILE: root, HOME: root, ProgramFiles: root },
        async () => [],
      ),
    ).toContain(program);
    expect(await resolveCodexCommand(program)).toMatchObject({ command: program, prefix: [] });
    await expect(resolveCodexCommand('codex --dangerous')).rejects.toThrow('绝对路径');
    await expect(resolveCodexCommand(path.join(root, 'missing.exe'))).rejects.toThrow('未找到');
  });

  it.skipIf(process.platform !== 'win32')(
    'finds the registered Windows package without PATH or a readable WindowsApps listing',
    async () => {
      const { root } = await setup();
      const packageRoot = path.join(root, 'registered package');
      const resources = path.join(packageRoot, 'app', 'resources');
      await fs.mkdir(resources, { recursive: true });
      const program = path.join(resources, 'codex.exe');
      await fs.writeFile(program, 'discovery-only fixture');
      const env = { PATH: '', USERPROFILE: root, ProgramFiles: root };
      await expect(findCodexPrograms(env, async () => [packageRoot])).resolves.toEqual([program]);
    },
  );

  it('launches a JS npm entry without shell interpolation', async () => {
    const session = new CodexCliSession(launchCodex);
    sessions.push(session);
    const frame = await session.complete(
      { ...defaultAgentSettings().providers.codex, cliPath: fixture },
      { ...request(), tools: [] },
      new AbortController().signal,
    );
    expect(frame.text).toContain('本机');
  });
});
