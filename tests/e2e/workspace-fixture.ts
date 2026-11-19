import { test as base, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testProject } from '../fixtures/project';
import type { Project } from '../../packages/domain/schema';

export async function seedBrowserProject(page: Page, project: Project) {
  await page.addInitScript((value) => {
    if (location.port !== '5173' || sessionStorage.getItem('test-project-seeded')) return;
    localStorage.setItem('frameforge.project.v1', JSON.stringify(value));
    sessionStorage.setItem('test-project-seeded', '1');
  }, project);
}

export async function createTestWorkspace() {
  const parent = path.resolve('.local');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'frameforge-e2e-'));
  return {
    directory,
    remove: () =>
      fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}

export const testWithWorkspace = base.extend<{ testWorkspace: string; seedProject: boolean }>({
  seedProject: [true, { option: true }],
  page: async ({ page, seedProject }, use) => {
    if (seedProject) {
      await page.context().addInitScript((project) => {
        if (location.port === '5173' && !localStorage.getItem('frameforge.project.v1')) {
          localStorage.setItem('frameforge.project.v1', JSON.stringify(project));
        }
      }, testProject());
    }
    await use(page);
  },
  testWorkspace: async ({}, use) => {
    const workspace = await createTestWorkspace();
    try {
      await use(workspace.directory);
    } finally {
      await workspace.remove();
    }
  },
});
