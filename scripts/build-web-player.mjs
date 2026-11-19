import { build } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'public/web-player');
await build({
  configFile: false,
  root: path.join(root, 'web-player'),
  plugins: [react()],
  publicDir: false,
  base: './',
  build: { outDir: output, emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
async function filesIn(directory, prefix = '') {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      files.push(...(await filesIn(path.join(directory, entry.name), `${relative}/`)));
    else files.push(relative);
  }
  return files;
}
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(await filesIn(output)));
