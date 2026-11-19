import type { Page } from '@playwright/test';

/** Acknowledge actual player dialogs in tests concerned with other features. */
export async function handlePlayerNotices(page: Page) {
  await page.addLocatorHandler(
    page.getByRole('alertdialog'),
    async (dialog) => {
      await dialog.getByRole('button', { name: '确认', exact: true }).click();
    },
    { noWaitAfter: true },
  );
}

export async function clickPlayerAction(page: Page, label: string) {
  const button = page.getByRole('button', { name: label, exact: true });
  if (['暂停', '播放'].includes(label)) {
    // A closing dialog temporarily hides the top bar from ARIA. Inspect its
    // actual HUD state before toggling, then let the click wait for focus restore.
    if ((await page.locator('.player-topbar').getAttribute('hidden')) !== null)
      await page.getByRole('region', { name: '游戏画面', exact: true }).press('Enter');
  } else if (!(await button.isVisible())) {
    await page.getByRole('button', { name: '菜单', exact: true }).click();
  }
  await button.click();
}

export async function resumePlayer(page: Page) {
  const resume = page.getByRole('button', { name: '继续播放', exact: true });
  if (await resume.isVisible()) await resume.click();
}
