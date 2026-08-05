import { ROLE_CONTRACTS } from '../config/roles.ts';
import { test, expect } from '../browser/fixture.ts';

test('role storage state restores an authenticated UI session', async ({ page, qaRole, evidence }) => {
  evidence.record('open', '/login with preloaded role storage state');
  await page.goto('/login');
  await expect(page).toHaveURL((url) => url.pathname === ROLE_CONTRACTS[qaRole].home);
  await expect(page.locator('#main')).toBeVisible();
  await expect(page.locator('#main h1').first()).toHaveText(ROLE_CONTRACTS[qaRole].dashboardHeading);
});
