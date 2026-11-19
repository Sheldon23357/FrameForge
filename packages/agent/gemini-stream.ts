import { parseModelFrame } from './providers';
import { agentReplyCharacterLimit, type ModelFrame, type ModelStreamListener } from './types';

type GeminiPart = Record<string, unknown> & { text?: string; thought?: boolean };
type GeminiChunk = {
  error?: unknown;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: Record<string, number>;
  candidates?: {
    index?: number;
    finishReason?: string;
    content?: {
      role?: string;
      parts?: GeminiPart[];
    };
  }[];
};

export class GeminiStreamInterrupted extends Error {}

const summaryCharacterLimit = 8000;

/** Assemble the native model message before handing any tool calls to the host. */
export async function readGeminiStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onActivity: () => void,
  onDelta?: ModelStreamListener,
  includeThoughts = false,
): Promise<ModelFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: GeminiPart[] = [];
  let finishReason: string | undefined;
  let usage: GeminiChunk['usageMetadata'];
  let role = 'model';
  let dataLines: string[] = [];
  let buffer = '';
  let preview = '';
  let summary = '';
  let summaryCharacters = 0;
  let receivedBytes = 0;
  let publicCharacters = 0;
  let done = false;
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });

  function readLine(line: string) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
      return;
    }
    if (line || !dataLines.length) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '[DONE]') return;
    let chunk: GeminiChunk;
    try {
      chunk = JSON.parse(data);
      if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw new Error();
    } catch {
      throw new GeminiStreamInterrupted('Gemini 流返回了不完整的事件。');
    }
    if (chunk.error) throw new GeminiStreamInterrupted('Gemini 流在生成过程中中断。');
    if (
      chunk.promptFeedback?.blockReason &&
      chunk.promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED'
    )
      throw new Error('Gemini 未返回有效内容，可能被安全规则阻止。');
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    const candidate = chunk.candidates?.find((item) => (item.index ?? 0) === 0);
    if (!candidate) return;
    if (candidate.finishReason && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED')
      finishReason = candidate.finishReason;
    if (candidate.content?.role) role = candidate.content.role;
    const incoming = candidate.content?.parts;
    if (incoming?.length || candidate.finishReason) onActivity();
    if (!Array.isArray(incoming)) return;
    for (const part of incoming) {
      if (!part || typeof part !== 'object')
        throw new GeminiStreamInterrupted('Gemini 流返回了无效的内容片段。');
      parts.push(part);
      if (typeof part.text !== 'string') continue;
      if (!part.thought) {
        publicCharacters += part.text.length;
        preview += part.text;
      } else if (
        part.thought === true &&
        includeThoughts &&
        summaryCharacters < summaryCharacterLimit
      ) {
        const remaining = summaryCharacterLimit - summaryCharacters;
        summary += part.text.length > remaining ? part.text.slice(0, remaining) + '…' : part.text;
        summaryCharacters += part.text.length;
      }
    }
  }

  try {
    while (!done) {
      signal.throwIfAborted();
      const next = await reader.read().catch(() => {
        signal.throwIfAborted();
        throw new GeminiStreamInterrupted('Gemini 响应未接收完整，连接已中断。');
      });
      signal.throwIfAborted();
      done = next.done;
      receivedBytes += next.value?.byteLength ?? 0;
      if (receivedBytes > 4_000_000) return { text: '', calls: [], raw: null, finish: 'length' };
      buffer += decoder.decode(next.value, { stream: !done });
      const newline = /\r\n|[\r\n]/g;
      let start = 0;
      for (let match = newline.exec(buffer); match; match = newline.exec(buffer)) {
        // A CR at a network boundary may be followed by LF in the next read.
        if (!done && match[0] === '\r' && newline.lastIndex === buffer.length) break;
        readLine(buffer.slice(start, match.index));
        start = newline.lastIndex;
      }
      buffer = buffer.slice(start);
      if (publicCharacters > agentReplyCharacterLimit)
        return { text: '', calls: [], raw: null, finish: 'length' };
      if (summary) onDelta?.({ kind: 'thoughtSummary', text: summary });
      if (preview) onDelta?.({ kind: 'text', text: preview });
      preview = '';
      summary = '';
    }
    if (!finishReason || dataLines.length || buffer.trim())
      throw new GeminiStreamInterrupted('Gemini 响应未接收完整，未执行该批操作。');
    return parseModelFrame('gemini', {
      candidates: [{ content: { role, parts }, finishReason }],
      usageMetadata: usage,
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!done) cancel();
    reader.releaseLock();
  }
}
