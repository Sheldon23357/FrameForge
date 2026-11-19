import { testWithWorkspace } from './workspace-fixture';
import { handlePlayerNotices } from './player-helpers';
export * from '@playwright/test';
export const test = testWithWorkspace.extend({
  page: async ({ page }, use) => {
    await handlePlayerNotices(page);
    await use(page);
  },
});
