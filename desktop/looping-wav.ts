export const ambientDurationSeconds = 20;

/** Make a 20-second PCM loop with overlap at source repeats and at the output seam. */
export function loopingAmbientWav(input: Buffer): Buffer {
  let format: Buffer | undefined;
  let samples: Buffer | undefined;
  for (let offset = 12; offset + 8 <= input.length;) {
    const size = input.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > input.length) break;
    const chunk = input.toString('ascii', offset, offset + 4);
    if (chunk === 'fmt ') format = input.subarray(start, start + size);
    if (chunk === 'data') samples = input.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  const invalid = () => new Error('豆包返回的 WAV 无法制作循环环境声，请重新生成。');
  if (!format || format.length < 16 || !samples) throw invalid();
  const codec = format.readUInt16LE(0);
  const pcm =
    codec === 1 ||
    (codec === 0xfffe &&
      format.length >= 40 &&
      format.subarray(24, 40).equals(Buffer.from('0100000000001000800000aa00389b71', 'hex')));
  const channels = format.readUInt16LE(2);
  const rate = format.readUInt32LE(4);
  const bytesPerFrame = channels * 2;
  if (
    !pcm ||
    channels < 1 ||
    channels > 2 ||
    rate < 8000 ||
    rate > 48000 ||
    format.readUInt16LE(14) !== 16 ||
    format.readUInt16LE(12) !== bytesPerFrame
  )
    throw invalid();
  const sourceFrames = Math.floor(samples.length / bytesPerFrame);
  if (sourceFrames < 2) throw invalid();
  const frames = rate * ambientDurationSeconds;
  const overlap = Math.min(Math.round(rate * 0.15), Math.floor(sourceFrames / 2));
  const period = sourceFrames - overlap;
  const repeat = sourceFrames < frames + overlap;
  const blend = (a: number, b: number, position: number) => a + (b - a) * (position / overlap);
  const sourceSample = (frame: number, channel: number) =>
    samples.readInt16LE(frame * bytesPerFrame + channel * 2);
  const sample = (frame: number, channel: number) => {
    if (!repeat) return sourceSample(frame, channel);
    const phase = frame % period;
    const head = sourceSample(phase, channel);
    return phase < overlap ? blend(sourceSample(period + phase, channel), head, phase) : head;
  };

  const size = frames * bytesPerFrame;
  const result = Buffer.allocUnsafe(44 + size);
  result.write('RIFF', 0);
  result.writeUInt32LE(36 + size, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(channels, 22);
  result.writeUInt32LE(rate, 24);
  result.writeUInt32LE(rate * bytesPerFrame, 28);
  result.writeUInt16LE(bytesPerFrame, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36);
  result.writeUInt32LE(size, 40);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const current = sample(frame, channel);
      const value =
        frame < overlap ? blend(sample(frames + frame, channel), current, frame) : current;
      result.writeInt16LE(Math.round(value), 44 + frame * bytesPerFrame + channel * 2);
    }
  }
  return result;
}
