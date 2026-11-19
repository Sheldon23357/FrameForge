import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: 'release-public-files',
      apply: 'build',
      async writeBundle({ dir }) {
        if (!dir) return;
        for (const file of ['app-icon.png', 'web-player']) {
          await cp(resolve('public', file), resolve(dir, file), { recursive: true });
        }
      },
    },
    {
      name: 'production-csp',
      transformIndexHtml(html) {
        if (command !== 'build') return html;
        return {
          html,
          tags: [
            {
              tag: 'meta',
              attrs: {
                'http-equiv': 'Content-Security-Policy',
                content:
                  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: frameforge:; media-src 'self' blob: frameforge:; font-src 'self'; connect-src 'self' blob: frameforge:; object-src 'none'; base-uri 'self';",
              },
              injectTo: 'head-prepend',
            },
          ],
        };
      },
    },
  ],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/.local/**', '**/release/**', '**/productions/**'] },
  },
  build: { chunkSizeWarningLimit: 900, copyPublicDir: false },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'tests/unit/echo-*.test.ts'],
    environment: 'node',
  },
}));
