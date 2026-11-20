import { test as setup, expect } from './fixtures';
import { STORAGE_STATE } from '../playwright.config';

setup('sign in as a local admin', async ({ page }) => {
    const email = process.env.QX7_EMAIL;
    const password = process.env.QX7_PASSWORD;

    if (!email || !password) {
        throw new Error('Set QX7_EMAIL and QX7_PASSWORD in .env (copy .env.example) before running the tests.');
    }

    await page.goto('/login');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForLoadState('load');

    if (await page.getByText('Invalid Email or Password').isVisible()) {
        throw new Error(
            `${page.url()} rejected QX7_EMAIL / QX7_PASSWORD from .env ("Invalid Email or Password"). ` +
            'Use an admin account that exists in the local QX7 database.'
        );
    }

    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });

    await page.context().storageState({ path: STORAGE_STATE });
});
