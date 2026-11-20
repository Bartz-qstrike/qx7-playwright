import { test, expect } from '../fixtures';
import { login } from '../helpers/login';

// Start every test here logged out, ignoring the saved session in .auth/admin.json.
test.use({ storageState: { cookies: [], origins: [] } });

const email = process.env.QX7_EMAIL;
const password = process.env.QX7_PASSWORD;

test.describe('QX7 login', () => {
    test.beforeAll(() => {
        if (!email || !password) {
            throw new Error('Set QX7_EMAIL and QX7_PASSWORD in .env before running the login test.');
        }
    });

    test('signs in with valid credentials', async ({ page }) => {
        await login(page);
        await expect(page.getByText('Invalid Email or Password')).toHaveCount(0);
    });

    test('rejects a wrong password', async ({ page }) => {
        await page.goto('/login');

        await page.locator('input[name="email"]').fill(email!);
        await page.locator('input[name="password"]').fill(`${password}-wrong`);
        await page.getByRole('button', { name: 'Sign In' }).click();

        await expect(page.getByText('Invalid Email or Password')).toBeVisible();
        await expect(page).toHaveURL(/\/login/);
    });
});
