import type { Page } from '@playwright/test';
import { ROLE_CONTRACTS, isRouteAllowed, type UiRole } from '../config/roles.ts';
import { test, expect } from '../browser/fixture.ts';

function control(page: Page, role: UiRole, name: string) {
  return page.getByRole(role, { name, exact: true });
}

test('role reaches its core route and control', async ({ page, qaRole, evidence }) => {
  const contract = ROLE_CONTRACTS[qaRole];
  expect(isRouteAllowed(qaRole, contract.coreRoute.path)).toBe(true);
  evidence.record('core-route', contract.coreRoute.path);
  await page.goto(contract.coreRoute.path);
  await expect(page).toHaveURL((url) => url.pathname === contract.coreRoute.path);
  await expect(page.getByRole('heading', { level: 1, name: contract.coreRoute.heading, exact: true })).toBeVisible();
  await expect(control(page, contract.coreControl.role, contract.coreControl.name)).toBeVisible();
});

test('representative positive route matrix follows App.tsx', async ({ page, qaRole, evidence }) => {
  for (const route of ROLE_CONTRACTS[qaRole].representativeAllowedRoutes) {
    expect(isRouteAllowed(qaRole, route.path)).toBe(true);
    evidence.record('allowed-route', route.path);
    await page.goto(route.path);
    await expect(page).toHaveURL((url) => url.pathname === route.path);
    await expect(page.getByRole('heading', { level: 1, name: route.heading, exact: true })).toBeVisible();
  }
});

test('negative direct-route matrix redirects without rendering protected content', async ({ page, qaRole, evidence }) => {
  const contract = ROLE_CONTRACTS[qaRole];
  for (const route of contract.deniedRoutes) {
    expect(isRouteAllowed(qaRole, route.path)).toBe(false);
    evidence.record('denied-route', route.path);
    await page.goto(route.path);
    await expect(page).toHaveURL((url) => url.pathname === route.redirectedTo);
    await expect(page.locator('#main h1').first()).toHaveText(contract.dashboardHeading);
  }
});
