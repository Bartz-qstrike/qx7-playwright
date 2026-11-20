import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

export const STORAGE_STATE = '.auth/admin.json';

export default defineConfig({
    testDir: './tests',
    // The pages use synchronous AJAX and shared local data; run one test at a time.
    fullyParallel: false,
    workers: 1,
    timeout: 60_000,
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: process.env.QX7_BASE_URL || 'http://qx7.test',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'setup',
            testMatch: /auth\.setup\.ts/,
        },
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
            dependencies: ['setup'],
            testIgnore: /auth\.setup\.ts/,
        },
    ],
});
