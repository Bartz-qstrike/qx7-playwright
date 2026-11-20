import { test as base, expect } from '@playwright/test';

/**
 * Shared `test` for every QX7 area. Import { test, expect } from here instead of '@playwright/test'.
 *
 * Adds an automatic `errorScreenshots` fixture: whenever the page hits an error during a test, it takes a
 * full-page screenshot at that moment and attaches it (plus a .txt with the details) to the test result.
 * Errors captured:
 *   - page-error      uncaught JavaScript exception
 *   - console-error   console.error(...)
 *   - http-<status>   any response with status >= 400
 *   - request-failed  a request that never got a response
 *   - error-toast     a toastr error message shown to the user (e.g. "MSRP cannot be empty!")
 * Screenshots never fail a test by themselves; Playwright's own screenshot on failure still applies.
 * Files land in test-results/<test>/ and in the HTML report (npx playwright show-report).
 */
export const test = base.extend<{ errorScreenshots: void }>({
    errorScreenshots: [
        async ({ page }, use, testInfo) => {
            const pending: Promise<void>[] = [];
            const seen = new Set<string>();
            let count = 0;

            const capture = (kind: string, detail: string) => {
                const key = `${kind}|${detail}`;
                if (seen.has(key)) {
                    return; // same error repeating: one screenshot is enough
                }
                seen.add(key);

                const name = `error-${String(++count).padStart(2, '0')}-${kind}`;
                pending.push(
                    (async () => {
                        try {
                            const screenshotPath = testInfo.outputPath(`${name}.png`);
                            await page.screenshot({ path: screenshotPath, fullPage: true });
                            await testInfo.attach(`${name}.png`, { path: screenshotPath, contentType: 'image/png' });
                            await testInfo.attach(`${name}.txt`, {
                                body: `${kind}\n${page.url()}\n\n${detail}`,
                                contentType: 'text/plain',
                            });
                        } catch {
                            // The page was already closed or navigating; nothing to capture.
                        }
                    })()
                );
            };

            page.on('pageerror', (error) => capture('page-error', error.stack || error.message));
            page.on('console', (message) => {
                if (message.type() === 'error') {
                    capture('console-error', message.text());
                }
            });
            page.on('response', (response) => {
                if (response.status() >= 400) {
                    capture(`http-${response.status()}`, `${response.request().method()} ${response.url()}`);
                }
            });
            page.on('requestfailed', (request) =>
                capture('request-failed', `${request.method()} ${request.url()}\n${request.failure()?.errorText ?? ''}`)
            );

            // toastr error popups are plain DOM, so watch for them from inside the page.
            await page.exposeFunction('__qx7ReportErrorToast', (text: string) => capture('error-toast', text));
            await page.addInitScript(() => {
                const report = (node: Element) => {
                    const toasts = node.matches('.toast-error') ? [node] : Array.from(node.querySelectorAll('.toast-error'));
                    for (const toast of toasts) {
                        const text = (toast.querySelector('.toast-message') || toast).textContent || '';
                        (window as any).__qx7ReportErrorToast(text.trim());
                    }
                };
                const start = () =>
                    new MutationObserver((mutations) => {
                        for (const mutation of mutations) {
                            mutation.addedNodes.forEach((node) => {
                                if (node instanceof Element) {
                                    report(node);
                                }
                            });
                        }
                    }).observe(document.body, { childList: true, subtree: true });

                if (document.body) {
                    start();
                } else {
                    document.addEventListener('DOMContentLoaded', start);
                }
            });

            await use();

            await Promise.all(pending);
        },
        { auto: true },
    ],
});

export { expect };
