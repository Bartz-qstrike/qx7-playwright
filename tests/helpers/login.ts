import { Page, expect } from '@playwright/test';

/** Signs in at /login with QX7_EMAIL / QX7_PASSWORD from .env and waits until the app leaves the login page. */
export async function login(page: Page): Promise<void> {
    const email = process.env.QX7_EMAIL;
    const password = process.env.QX7_PASSWORD;
    if (!email || !password) {
        throw new Error('Set QX7_EMAIL and QX7_PASSWORD in .env before logging in.');
    }

    await page.goto('/login');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForLoadState('load');

    if (await page.getByText('Invalid Email or Password').isVisible()) {
        throw new Error('QX7 rejected QX7_EMAIL / QX7_PASSWORD from .env ("Invalid Email or Password").');
    }
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}
