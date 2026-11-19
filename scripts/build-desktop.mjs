import { build } from 'esbuild';
await build({
  entryPoints: ['desktop/main.ts'],
  outfile: 'dist-desktop/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
});
await build({
  entryPoints: ['desktop/preload.ts'],
  outfile: 'dist-desktop/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
