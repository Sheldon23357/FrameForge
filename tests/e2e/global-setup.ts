import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const colors = {
  primary: '0x263548',
  secondary: '0x435a38',
  tertiary: '0x623e4e',
};

export default async function setup() {
  const root = path.resolve('public/test-media');
  await fs.mkdir(root, { recursive: true });
  const files: string[] = [];
  const cleanup = () => Promise.all(files.map((file) => fs.rm(file, { force: true })));
  try {
    for (const [name, color] of Object.entries(colors)) {
      const clip = path.join(root, `${name}.mp4`);
      const poster = path.join(root, `${name}.jpg`);
      files.push(clip, poster);
      await run('ffmpeg', [
        '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=960x540:r=12:d=9`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip,
      ]);
      await run('ffmpeg', ['-v', 'error', '-y', '-i', clip, '-vf', 'scale=640:360', '-frames:v', '1', poster]);
    }
    const audio = path.join(root, 'tone.wav');
    files.push(audio);
    await run('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20:sample_rate=24000',
      audio,
    ]);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return async () => {
    await cleanup();
    await fs.rmdir(root).catch(() => undefined);
  };
}
