import type { ModelExchange, ModelFrame, ModelRequest } from './types';
import { agentReplyCharacterLimit } from './types';
import { geminiGenerationConfig, type ProviderConfig, type ProviderId } from './settings';

type Json = Record<string, any>;
function appendFeedback(rows: Json[], exchange: ModelExchange, gemini = false) {
  if (exchange.feedback)
    rows.push(
      gemini
        ? { role: 'user', parts: [{ text: exchange.feedback }] }
        : { role: 'user', content: exchange.feedback },
    );
}
export function providerRequest(
  provider: ProviderId,
  config: ProviderConfig,
  key: string,
  input: ModelRequest,
  { streamGemini = true, includeThoughts = false } = {},
) {
  if (provider === 'codex') throw new Error('Codex CLI 使用本机 app-server 协议。');
  const base = config.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let url: string, body: unknown;
  if (provider === 'openai') {
    headers.Authorization = `Bearer ${key}`;
    const rows: Json[] = input.messages.map((m) => ({ ...m }));
    for (const exchange of input.exchanges) {
      if (!Array.isArray(exchange.frame.raw)) throw new Error('OpenAI 历史响应格式不兼容。');
      rows.push(...exchange.frame.raw);
      for (const { call, result } of exchange.replies)
        rows.push({
          type: 'function_call_output',
          call_id: call.id,
          output: JSON.stringify(result),
        });
      appendFeedback(rows, exchange);
    }
    url = `${base}/responses`;
    body = {
      model: config.model,
      instructions: input.system,
      input: rows,
      tools: input.tools.map((t) => ({ type: 'function', ...t, strict: false })),
      max_output_tokens: input.maxOutputTokens,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'medium' },
    };
  } else if (provider === 'gemini') {
    headers['x-goog-api-key'] = key;
    const rows: Json[] = input.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    for (const exchange of input.exchanges) {
      const raw = exchange.frame.raw as Json;
      if (!Array.isArray(raw?.parts)) throw new Error('Gemini 历史响应格式不兼容。');
      // Preserve every part verbatim, including native thoughtSignature and functionCall.id.
      rows.push(raw);
      if (exchange.replies.length)
        rows.push({
          role: 'user',
          parts: exchange.replies.map(({ call, result }) => {
            const native = raw.parts.find(
              (p: Json) => p.functionCall?.id === call.id,
            )?.functionCall;
            return {
              functionResponse: {
                name: call.name,
                ...(native?.id ? { id: native.id } : {}),
                response: result,
              },
            };
          }),
        });
      appendFeedback(rows, exchange, true);
    }
    const method = streamGemini ? 'streamGenerateContent?alt=sse' : 'generateContent';
    url = `${base}/models/${encodeURIComponent(config.model)}:${method}`;
    if (streamGemini) headers.Accept = 'text/event-stream';
    body = {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: rows,
      ...(input.tools.length
        ? {
            tools: [
              {
                functionDeclarations: input.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.parameters,
                })),
              },
            ],
          }
        : {}),
      generationConfig: geminiGenerationConfig(
        config.model,
        input.maxOutputTokens,
        streamGemini && includeThoughts && !input.purpose,
      ),
    };
  } else {
    headers.Authorization = `Bearer ${key}`;
    const rows: Json[] = [{ role: 'system', content: input.system }, ...input.messages];
    for (const exchange of input.exchanges) {
      const raw = exchange.frame.raw as Json;
      if (raw?.role !== 'assistant') throw new Error('模型历史响应格式不兼容。');
      // MiniMax and thinking DeepSeek require their original reasoning_content on tool turns.
      rows.push(raw);
      for (const { call, result } of exchange.replies)
        rows.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      appendFeedback(rows, exchange);
    }
    url = `${base}/chat/completions`;
    body = {
      model: config.model,
      messages: rows,
      ...(input.tools.length
        ? { tools: input.tools.map((t) => ({ type: 'function', function: t })) }
        : {}),
      stream: false,
      max_tokens: input.maxOutputTokens,
      ...(provider === 'deepseek'
        ? { thinking: { type: 'enabled' }, reasoning_effort: 'low' }
        : { reasoning_effort: 'low', reasoning_split: true }),
    };
  }
  return {
    url,
    init: { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error' as const },
  };
}

export function parseModelFrame(provider: ProviderId, payload: Json): ModelFrame {
  if (provider === 'codex') throw new Error('Codex CLI 使用本机 app-server 协议。');
  if (
    !payload ||
    payload.error ||
    (payload.base_resp?.status_code && payload.base_resp.status_code !== 0)
  )
    throw new Error('模型服务返回错误，请检查账户状态与模型权限。');
  if (provider === 'openai') {
    if (!Array.isArray(payload.output) || !['completed', 'incomplete'].includes(payload.status))
      throw new Error('OpenAI 未返回完整的有效响应。');
    const raw = payload.output;
    const text = raw
      .filter((p: Json) => p.type === 'message')
      .flatMap((p: Json) => p.content ?? [])
      .filter((p: Json) => p.type === 'output_text' || p.type === 'refusal')
      .map((p: Json) => p.text ?? p.refusal ?? '')
      .join('\n');
    const calls = raw
      .filter((p: Json) => p.type === 'function_call')
      .map((p: Json) => ({ id: p.call_id, name: p.name, arguments: p.arguments }));
    return checkFrame({
      text,
      calls,
      raw,
      finish: payload.status === 'incomplete' ? 'length' : 'complete',
      usage: { input: payload.usage?.input_tokens ?? 0, output: payload.usage?.output_tokens ?? 0 },
    });
  }
  if (provider === 'gemini') {
    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS')
      return { text: '', calls: [], raw: null, finish: 'length' };
    if (
      ['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS'].includes(
        candidate?.finishReason,
      )
    )
      return invalidFrame(`Gemini 结束原因：${candidate.finishReason}`);
    const raw = candidate?.content;
    if (!Array.isArray(raw?.parts)) throw new Error('Gemini 未返回有效内容，可能被安全规则阻止。');
    if (
      raw.parts.some(
        (p: Json) => p.functionCall?.willContinue || p.functionCall?.partialArgs?.length,
      )
    )
      return invalidFrame('Gemini 未返回完整的工具参数。');
    if (candidate.finishReason && candidate.finishReason !== 'STOP')
      return invalidFrame('Gemini 未正常结束响应。');
    const text = raw.parts
      .filter((p: Json) => p.text && !p.thought)
      .map((p: Json) => p.text)
      .join('');
    const calls = raw.parts
      .filter((p: Json) => p.functionCall)
      .map((p: Json, i: number) => ({
        id: p.functionCall.id ?? `gemini_${crypto.randomUUID()}_${i}`,
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args ?? {}),
      }));
    return checkFrame({
      text,
      calls,
      raw,
      finish: 'complete',
      usage: {
        input: payload.usageMetadata?.promptTokenCount ?? 0,
        output: payload.usageMetadata?.candidatesTokenCount ?? 0,
      },
    });
  }
  const choice = payload.choices?.[0];
  const raw = choice?.message;
  if (raw?.role !== 'assistant') throw new Error('模型未返回有效的助手消息。');
  const text =
    typeof raw.content === 'string'
      ? raw.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
      : '';
  const calls = (raw.tool_calls ?? []).map((p: Json) => ({
    id: p.id,
    name: p.function?.name,
    arguments: p.function?.arguments,
  }));
  const leakedMiniMaxCall =
    provider === 'minimax' && /<\s*\]?minimax\[?\s*>/i.test(text) && /<\/?tool_call\b/i.test(text);
  if (leakedMiniMaxCall && !calls.length && choice.finish_reason !== 'length')
    return invalidFrame('MiniMax 将工具调用写进了正文，请通过 tools 重新发出调用。');
  return checkFrame({
    text: leakedMiniMaxCall ? '' : text,
    calls,
    raw,
    finish: choice.finish_reason === 'length' ? 'length' : 'complete',
    usage: {
      input: payload.usage?.prompt_tokens ?? 0,
      output: payload.usage?.completion_tokens ?? 0,
    },
  });
}
function checkFrame(frame: ModelFrame): ModelFrame {
  if (frame.finish === 'length') return { ...frame, text: '', calls: [], raw: null };
  if (frame.text.length > agentReplyCharacterLimit) return invalidFrame('模型答复过长。');
  if (frame.calls.length > 20)
    return invalidFrame(`模型一次返回了 ${frame.calls.length} 次工具调用，上限为 20 次。`);
  if (
    frame.calls.some(
      (c) =>
        typeof c.id !== 'string' ||
        typeof c.name !== 'string' ||
        typeof c.arguments !== 'string' ||
        c.arguments.length > 64000,
    )
  )
    return invalidFrame('模型工具调用的 ID、名称或参数无效。');
  if (new Set(frame.calls.map((c) => c.id)).size !== frame.calls.length)
    return invalidFrame('模型返回了重复的工具调用 ID。');
  return frame;
}
function invalidFrame(issue: string): ModelFrame {
  return { text: '', calls: [], raw: null, finish: 'invalid', issue };
}
export function modelFailure(status: number, payload: Json | null): string {
  if (
    ['credit_balance_exhausted', 'insufficient_quota', 'billing_hard_limit_reached'].includes(
      payload?.error?.code,
    )
  )
    return '账户余额或额度已用尽，请检查服务商计费设置。';
  if (payload?.error?.status === 'FAILED_PRECONDITION')
    return '当前账户或网络地区不满足模型服务的使用条件。';
  return (
    (
      {
        400: '模型请求不被支持，请检查模型 ID 与接口协议。',
        401: 'API Key 无效、已过期或与接口区域不匹配。',
        402: '模型账户余额不足。',
        403: '无权访问该模型，请检查账户权限和地区。',
        404: '模型或接口不存在。',
        429: '模型请求受限或额度不足，请稍后重试。',
      } as Record<number, string>
    )[status] ?? `模型服务暂时不可用（HTTP ${status}）。`
  );
}
