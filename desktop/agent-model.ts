import { setTimeout as delay } from 'node:timers/promises';
import type { AgentSettingsService } from './agent-settings';
import {
  modelRequestSchema,
  type ModelFrame,
  type ModelRequest,
  type ModelStreamListener,
} from '../packages/agent/types';
import { modelFailure, parseModelFrame, providerRequest } from '../packages/agent/providers';
import { GeminiStreamInterrupted, readGeminiStream } from '../packages/agent/gemini-stream';
import { geminiSupportsThoughtSummaries } from '../packages/agent/settings';
import { CodexCliSession, launchCodex, type CodexLauncher } from './codex-cli';

const codexResponseTimeoutMs = 180_000;
const geminiIdleTimeoutMs = 180_000;
const geminiResponseTimeoutMs = 300_000;
const apiResponseTimeoutMs = 90_000;
const geminiReconnectDelayMs = 1500;

interface RunState {
  controller: AbortController;
  model: Awaited<ReturnType<AgentSettingsService['resolveModel']>>;
  pending: boolean;
  codex?: CodexCliSession;
  codexTaskStep?: string;
  geminiUnary?: boolean;
}
export class AgentModelService {
  private runs = new Map<string, RunState>();
  private ended = new Set<string>();
  constructor(
    private settings: AgentSettingsService,
    private request: (url: string, init?: RequestInit) => Promise<Response> = fetch,
    private codexLauncher: CodexLauncher = launchCodex,
  ) {}
  cancel(runId: string) {
    this.runs.get(runId)?.controller.abort();
    this.runs.get(runId)?.codex?.close();
    this.runs.delete(runId);
    this.ended.add(runId);
    if (this.ended.size > 256) this.ended.delete(this.ended.values().next().value!);
  }
  cancelAll() {
    for (const id of this.runs.keys()) this.cancel(id);
  }
  async complete(input: ModelRequest, onDelta?: ModelStreamListener): Promise<ModelFrame> {
    if (JSON.stringify(input).length > 1_500_000) throw new Error('模型请求超出上下文传输限制。');
    const parsed = modelRequestSchema.safeParse(input);
    if (!parsed.success) throw new Error('模型请求格式无效。');
    const data = parsed.data as ModelRequest;
    if (this.ended.has(data.runId)) throw new Error('该轮创作已经停止。');
    let run = this.runs.get(data.runId);
    if (!run) {
      if (this.runs.size >= 2) throw new Error('已有创作任务运行，请先停止其他任务。');
      const controller = new AbortController();
      const placeholder = { controller, pending: true, model: null! } as RunState;
      this.runs.set(data.runId, placeholder);
      try {
        placeholder.model = await this.settings.resolveModel(data.provider);
        if (controller.signal.aborted) throw new Error('该轮创作已经停止。');
        placeholder.pending = false;
        run = placeholder;
      } catch (error) {
        this.runs.delete(data.runId);
        throw error;
      }
    }
    if (run.pending) throw new Error('同一轮创作不能并发请求模型。');
    if (run.model.provider !== data.provider)
      throw new Error('单轮创作不能切换服务商，请停止后重新发送。');
    run.pending = true;
    const active = run;
    const isCodex = data.provider === 'codex';
    const isGemini = data.provider === 'gemini';
    const timeoutMs = isCodex
      ? codexResponseTimeoutMs
      : isGemini
        ? geminiResponseTimeoutMs
        : apiResponseTimeoutMs;
    const codexTimeout = new Error(`Codex CLI 等待下一步响应超时（${timeoutMs / 1000} 秒）。`);
    // A Gemini deadline applies only to this response, so the host can continue the same run.
    const deadline = isGemini ? new AbortController() : active.controller;
    const signal = isGemini
      ? AbortSignal.any([active.controller.signal, deadline.signal])
      : active.controller.signal;
    const timeout = setTimeout(() => {
      deadline.abort(
        isCodex ? codexTimeout : isGemini ? new Error('Gemini 单次响应超过 5 分钟。') : undefined,
      );
    }, timeoutMs);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const onActivity = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => deadline.abort(new Error('Gemini 响应停顿超过 180 秒。')),
        geminiIdleTimeoutMs,
      );
    };
    if (isGemini) onActivity();
    try {
      if (isCodex) {
        // Empty exchanges also identify independent history-compaction requests.
        const reset =
          !data.exchanges.length ||
          active.codexTaskStep !== data.taskStep ||
          active.codex?.needsTools(data.tools);
        if (reset) {
          active.codex?.close();
          active.codex = new CodexCliSession(this.codexLauncher);
          active.codexTaskStep = data.taskStep;
        }
        if (!active.codex) throw new Error('Codex CLI 工具会话已失效，请重新发送。');
        return await active.codex.complete(
          active.model.config,
          reset ? { ...data, exchanges: [] } : data,
          active.controller.signal,
        );
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const stream = isGemini && !active.geminiUnary;
        const includeThoughts =
          stream &&
          Boolean(onDelta) &&
          !data.purpose &&
          geminiSupportsThoughtSummaries(active.model.config.model);
        const { url, init } = providerRequest(
          data.provider,
          active.model.config,
          active.model.apiKey,
          data,
          { streamGemini: stream, includeThoughts },
        );
        let response: Response;
        try {
          response = await this.request(url, { ...init, signal });
        } catch {
          if (isGemini) signal.throwIfAborted();
          if (signal.aborted) throw new Error(`模型请求已停止或超时（${timeoutMs / 1000} 秒）。`);
          if (attempt === 0) {
            if (isGemini) await delay(geminiReconnectDelayMs, undefined, { signal });
            continue;
          }
          if (isGemini) throw new GeminiStreamInterrupted('Gemini 网络连接未建立。');
          throw new Error('模型网络连接失败，请检查网络、代理和接口地址。');
        }
        if (isGemini) signal.throwIfAborted();
        if (
          stream &&
          response.ok &&
          /^text\/event-stream\b/i.test(response.headers.get('content-type') ?? '')
        ) {
          if (!response.body) throw new GeminiStreamInterrupted('Gemini 未返回可读取的响应流。');
          return await readGeminiStream(
            response.body,
            signal,
            onActivity,
            data.purpose ? undefined : onDelta,
            includeThoughts,
          );
        }
        const payload = await response.json().catch(() => null);
        if (isGemini) signal.throwIfAborted();
        if (!response.ok) {
          if (stream && attempt === 0 && [404, 405, 501].includes(response.status)) {
            active.geminiUnary = true;
            continue;
          }
          if (attempt === 0 && response.status >= 500) continue;
          if (isGemini && [408, 502, 503, 504].includes(response.status))
            throw new GeminiStreamInterrupted(`Gemini 网关暂不可用（HTTP ${response.status}）。`);
          throw new Error(modelFailure(response.status, payload));
        }
        return parseModelFrame(data.provider, payload);
      }
      throw new Error('模型请求失败。');
    } catch (error) {
      if (active.controller.signal.reason === codexTimeout) throw codexTimeout;
      if (isGemini) {
        if (active.controller.signal.aborted) throw new Error('该轮创作已经停止。');
        if (deadline.signal.aborted || error instanceof GeminiStreamInterrupted)
          return {
            text: '',
            calls: [],
            raw: null,
            finish: 'invalid',
            issue: deadline.signal.aborted
              ? (deadline.signal.reason as Error).message
              : (error as GeminiStreamInterrupted).message,
          };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      clearTimeout(idle);
      active.pending = false;
    }
  }
}
