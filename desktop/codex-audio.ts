import { z } from 'zod';
import type { ProductionAudioRequest } from '../packages/domain/production-audio';
import type { ProviderConfig } from '../packages/agent/settings';
import { CodexCliSession } from './codex-cli';

const frequency = z.number().min(20).max(8000);
const note = z.strictObject({
  startMs: z.number().int().min(0).max(30_000),
  durationMs: z.number().int().min(10).max(30_000),
  wave: z.enum(['sine', 'triangle', 'pluck', 'pad', 'noise']),
  hz: frequency,
  endHz: frequency.optional(),
  gain: z.number().min(0.01).max(1),
  attackMs: z.number().int().min(0).max(30_000).optional(),
  releaseMs: z.number().int().min(0).max(30_000).optional(),
});
const scoreSchema = z.strictObject({ notes: z.array(note).min(1).max(160) });
type Note = z.infer<typeof note>;
const sampleRate = 24_000;

function oscillator(wave: Note['wave'], phase: number) {
  const angle = phase * 2 * Math.PI;
  const sine = Math.sin(angle);
  if (wave === 'triangle') return (2 / Math.PI) * Math.asin(sine);
  if (wave === 'pluck') return sine * 0.7 + Math.sin(angle * 2) * 0.2 + Math.sin(angle * 3) * 0.1;
  if (wave === 'pad')
    return sine * 0.6 + Math.sin(angle * 1.004) * 0.25 + Math.sin(angle * 2) * 0.15;
  return sine;
}

export function synthesizeProductionAudio(raw: unknown, durationMs: number) {
  const parsed = scoreSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 4)
      .map(({ path, message }) => `${path.join('.') || 'JSON'} ${message}`);
    throw new Error(`音频编排字段无效：${details.join('；')}`);
  }
  const outside = parsed.data.notes.findIndex(
    ({ startMs, durationMs: length }) => startMs + length > durationMs,
  );
  if (outside !== -1) {
    const note = parsed.data.notes[outside];
    throw new Error(
      `notes.${outside} 结束于 ${note.startMs + note.durationMs}ms，超过请求的 ${durationMs}ms。`,
    );
  }
  if (parsed.data.notes.reduce((sum, note) => sum + note.durationMs, 0) > 240_000)
    throw new Error('所有音符时长之和超过 240000ms。');
  const frames = Math.round((durationMs * sampleRate) / 1000);
  const mix = new Float32Array(frames);
  let random = 723357;
  for (const n of parsed.data.notes) {
    const start = (n.startMs * sampleRate) / 1000;
    const length = (n.durationMs * sampleRate) / 1000;
    const attack = Math.max(1, Math.min(length, ((n.attackMs ?? 8) * sampleRate) / 1000));
    const release = Math.max(1, Math.min(length, ((n.releaseMs ?? 40) * sampleRate) / 1000));
    const sweep = (n.endHz ?? n.hz) - n.hz;
    let phase = 0;
    let filteredNoise = 0;
    for (let i = 0; i < length; i++) {
      const progress = i / length;
      const hz = n.hz + sweep * progress;
      const envelope = Math.min(1, i / attack, (length - 1 - i) / release);
      phase += hz / sampleRate;
      let sample: number;
      if (n.wave === 'noise') {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const cutoff = 1 - Math.exp((-2 * Math.PI * hz) / sampleRate);
        filteredNoise += cutoff * (random / 0x80000000 - 1 - filteredNoise);
        sample = filteredNoise;
      } else {
        sample = oscillator(n.wave, phase);
        if (n.wave === 'pluck') sample *= Math.exp(-4 * progress);
      }
      mix[start + i] += sample * envelope * n.gain;
    }
  }
  let peak = 0;
  for (const sample of mix) peak = Math.max(peak, Math.abs(sample));
  if (peak < 0.0001) throw new Error('Codex CLI 返回的音频编排没有可用声音。');
  const gain = Math.min(1, 0.9 / peak);
  const size = frames * 2;
  const wav = Buffer.alloc(44 + size);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + size, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(size, 40);
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(mix[i] * gain * 32767), 44 + i * 2);
  return wav;
}

export async function createCodexAudio(
  config: ProviderConfig,
  request: ProductionAudioRequest,
  signal: AbortSignal,
) {
  const cli = new CodexCliSession();
  try {
    const makeScore = async (correction?: string) =>
      cli.complete(
        config,
        {
          runId: crypto.randomUUID(),
          provider: 'codex',
          system: [
            '你为 FrameForge 编排一段可本地合成的器乐 BGM。只输出紧凑 JSON，不调用工具。',
            '格式为 {"notes":[{"startMs":0,"durationMs":100,"wave":"pluck","hz":220,"gain":0.4}]}。',
            '每个音符可叠加，wave 仅 sine、triangle、pluck、pad、noise。hz 为音高；noise 时为低通截止频率。endHz 可选，用于扫频。',
            'attackMs 与 releaseMs 可选。为旋律、和声、低音和节奏安排独立音符，编排适合连续铺底的音乐。仅编排器乐配乐，省略拟音、环境声和人声。',
            `本次输出总长 ${request.durationMs}ms。对每个音符，startMs + durationMs 必须小于或等于 ${request.durationMs}，durationMs 至少 10；两者使用整数毫秒。`,
            '频率 20–8000 Hz，gain 0.01–1，最多 160 个音符，音符时长之和最多 240000 毫秒。围绕用户描述编排，避免长段空白。',
          ].join('\n'),
          messages: [
            {
              role: 'user',
              content: correction
                ? `${JSON.stringify(request)}\n上次编排未通过：${correction} 请重写整份 JSON，并在输出前检查各项约束。`
                : JSON.stringify(request),
            },
          ],
          tools: [],
          exchanges: [],
          maxOutputTokens: 16000,
        },
        signal,
      );
    const mixScore = (text: string) => {
      signal.throwIfAborted();
      let score: unknown;
      try {
        score = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
      } catch {
        throw new Error('没有返回合法的音频编排 JSON。');
      }
      return synthesizeProductionAudio(score, request.durationMs);
    };
    const first = await makeScore();
    try {
      return mixScore(first.text);
    } catch (error) {
      signal.throwIfAborted();
      const correction = error instanceof Error ? error.message : '音频编排无法合成。';
      return mixScore((await makeScore(correction)).text);
    }
  } finally {
    cli.close();
  }
}
