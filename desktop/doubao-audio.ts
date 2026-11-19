import { randomUUID } from 'node:crypto';
import { providers, type ConnectionResult } from '../packages/agent/settings';

// At 24 kHz this fits a two-minute stereo WAV with room for JSON and Base64 overhead.
const maxResponseBytes = 24 * 1024 * 1024;

async function readAudioResponse(response: Response): Promise<Record<string, unknown> | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    return null;
  }
}

function isWav(audio: Buffer) {
  if (
    audio.length < 44 ||
    audio.toString('ascii', 0, 4) !== 'RIFF' ||
    audio.toString('ascii', 8, 12) !== 'WAVE'
  )
    return false;
  let format = false;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const id = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    if (offset + 8 + size > audio.length) return false;
    if (id === 'fmt ' && size >= 16) format = true;
    if (id === 'data' && size > 0 && format) return true;
    offset += 8 + size + (size % 2);
  }
  return false;
}

export async function testDoubaoAudio(
  request: (url: string, init?: RequestInit) => Promise<Response>,
  key: string,
  prompt: string,
  signal: AbortSignal,
  speechRate?: number,
): Promise<ConnectionResult> {
  const { baseUrl, model } = providers.doubaoTts;
  const response = await request(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': key,
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify({
      model,
      text_prompt: prompt,
      audio_config: {
        format: 'wav',
        sample_rate: 24000,
        ...(speechRate !== undefined ? { speech_rate: speechRate } : {}),
      },
    }),
    redirect: 'error',
    signal,
  });
  const payload = await readAudioResponse(response);
  const code =
    typeof payload?.code === 'number' && Number.isSafeInteger(payload.code)
      ? payload.code
      : undefined;
  if (!response.ok || (code !== undefined && code !== 0 && code !== 20000000)) {
    if (code === 45001125)
      return {
        ok: false,
        message:
          '豆包未通过试听文本审核（45001125）。请将名称或声音描述改为中性的音色、音高和口音说明后重试。',
      };
    const detail = code ? ` · 错误码 ${code}` : '';
    const explanation: Record<number, string> = {
      400: '请检查生成文本和模型权限。',
      401: '请检查豆包语音 API Key。',
      402: '请检查账户余额或套餐。',
      403: '请检查密钥权限和音频生成 1.0 是否已开通。',
      429: '请求过多，请稍后重试。',
    };
    const message = explanation[response.status] ?? '豆包语音生成失败。';
    return { ok: false, message: `HTTP ${response.status}${detail} · ${message}` };
  }
  const encoded = payload?.audio;
  if (
    typeof encoded !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    !isWav(Buffer.from(encoded, 'base64'))
  )
    return { ok: false, message: '豆包语音没有返回可播放的 WAV 音频。' };
  const duration = payload?.duration;
  return {
    ok: true,
    message: '连接成功，已生成测试音频。',
    audio: {
      wavBase64: encoded,
      ...(typeof duration === 'number' && Number.isFinite(duration) && duration > 0
        ? { durationSeconds: duration }
        : {}),
    },
  };
}
