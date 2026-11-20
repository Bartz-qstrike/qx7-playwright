import fs from 'fs';
import path from 'path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { login } from '../helpers/login';

/**
 * SRE-3215: for every Brand Block in the audit CSV
 *   open its edit page → open the Fabric Color modal → modal SAVE → Brand Block SAVE → next link.
 * Logs in once and keeps the same signed-in page for the whole run (never visits /logout).
 * Writes one row per block to programmatic-results/sre-3215-resave-<timestamp>.csv as it goes.
 */

// Start logged out so this file performs the login itself.
// No trace: this one test covers hundreds of pages, and a full trace of them filled the disk (7.8 GB by block 1052).
test.use({ storageState: { cookies: [], origins: [] }, trace: 'off' });

type BrandBlock = { id: string; name: string; link: string };
type Outcome = { ok: boolean; colors: number | ''; detail: string };

/** Reads the SRE-3215 CSV: ID is the first field, link the last, name everything in between (may contain commas). */
function readBrandBlocks(csvPath: string): BrandBlock[] {
    const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
    return lines.slice(1).map((line) => {
        const first = line.indexOf(',');
        const last = line.lastIndexOf(',');
        return {
            id: line.slice(0, first).trim(),
            name: line.slice(first + 1, last).trim().replace(/^"|"$/g, '').replace(/""/g, '"'),
            link: line.slice(last + 1).trim(),
        };
    });
}

const csvFile = process.env.QX7_SRE_3215_CSV || 'SRE-3215 Audit - Affected Block.csv';
const limit = Number(process.env.QX7_BLOCK_LIMIT) || undefined;
const fromId = process.env.QX7_BLOCK_FROM_ID?.trim();
// QX7_BLOCK_TO_ID (optional) stops after that block; see below.

let blocks = readBrandBlocks(path.resolve(csvFile));
if (fromId) {
    const start = blocks.findIndex((b) => b.id === fromId);
    if (start < 0) {
        throw new Error(`QX7_BLOCK_FROM_ID=${fromId} is not in ${csvFile}.`);
    }
    blocks = blocks.slice(start);
}
const toId = process.env.QX7_BLOCK_TO_ID?.trim();
if (toId) {
    const end = blocks.findIndex((b) => b.id === toId);
    if (end < 0) {
        throw new Error(`QX7_BLOCK_TO_ID=${toId} is not in ${csvFile} (after QX7_BLOCK_FROM_ID).`);
    }
    blocks = blocks.slice(0, end + 1);
}
blocks = blocks.slice(0, limit);

const resultsFile = path.resolve(
    'programmatic-results',
    `sre-3215-resave-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
);
const csvCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;

const errorToast = (page: Page) => page.locator('.toast-error').first();
const toastText = async (page: Page) => ((await errorToast(page).textContent()) || '').trim();

/** Waits for the first of: `success` resolving, or an error toast appearing (returns its text as a failure). */
async function untilDoneOrErrorToast<T>(page: Page, success: Promise<T>): Promise<{ value?: T; error?: string }> {
    const toast = errorToast(page)
        .waitFor({ state: 'visible', timeout: 60_000 })
        .then(async () => ({ error: await toastText(page) }));
    return Promise.race([success.then((value) => ({ value })), toast]).catch((e: Error) => ({
        error: String(e.message ?? e).split('\n')[0],
    }));
}

async function resaveBlock(page: Page, block: BrandBlock): Promise<Outcome> {
    // 1. Open the block, staying signed in.
    await page.goto(block.link);
    if (/\/login/.test(page.url())) {
        await login(page);
        await page.goto(block.link);
    }
    await page.waitForLoadState('networkidle');

    // 2. Open the Fabric Color modal (MODIFY, or ADD for blocks with no colors yet).
    const modal = page.locator('#fabricColorModal');
    const colorButton = page.locator('.fabric-color-btn:visible, .add-fabric-color-btn:visible').first();
    await page.evaluate(() => (window as any).toastr?.clear());
    await colorButton.click();
    const opened = await untilDoneOrErrorToast(page, modal.waitFor({ state: 'visible', timeout: 60_000 }));
    if (opened.error !== undefined) {
        return { ok: false, colors: '', detail: `Fabric Color modal: ${opened.error}` };
    }
    await page.waitForLoadState('networkidle'); // the modal's colors come from get_factory_color

    // 3. Save the modal: this fills the hidden #fabric-color field the Brand Block form sends.
    await modal.locator('.submit_button').click();
    await modal.waitFor({ state: 'hidden', timeout: 30_000 });
    const fabricColorJson = await page.locator('#fabric-color').inputValue();
    const colors = fabricColorJson ? (JSON.parse(fabricColorJson) as unknown[]).length : 0;
    if (colors === 0) {
        return { ok: false, colors, detail: 'no fabric colors in modal; Brand Block not saved' };
    }

    // 4. Save the Brand Block.
    await page.evaluate(() => (window as any).toastr?.clear());
    const updated = page.waitForResponse(
        (r) => r.url().includes('/block_pattern_rule/update') && r.request().method() === 'POST',
        { timeout: 60_000 }
    );
    await page.locator('button.save-brand-block').click();
    const saved = await untilDoneOrErrorToast(page, updated);
    if (saved.error !== undefined) {
        return { ok: false, colors, detail: `Brand Block SAVE: ${saved.error}` };
    }
    // QX7 redirects to the Brand Block list on success, and back to this block's edit page (with errors) on failure.
    const status = saved.value!.status();
    const location = saved.value!.headers()['location'] ?? '';
    await page.waitForLoadState('load');
    if (status >= 400) {
        return { ok: false, colors, detail: `Brand Block SAVE: HTTP ${status}` };
    }
    if (/\/login/.test(page.url())) {
        return { ok: false, colors, detail: 'redirected to login after Brand Block SAVE' };
    }
    if (!/\/admin\/brand\/block_pattern_rules\/?(\?.*)?$/.test(location)) {
        const pageErrors = (await page.locator('.alert-danger, .toast-error').allInnerTexts()).join(' | ').replace(/\s+/g, ' ').trim();
        return { ok: false, colors, detail: `Brand Block SAVE rejected (HTTP ${status} → ${location || page.url()})${pageErrors ? `: ${pageErrors}` : ''}` };
    }
    return { ok: true, colors, detail: `HTTP ${status} → Brand Block list` };
}

test(`re-saves fabric colors for each Brand Block from ${csvFile}`, async ({ page }) => {
    test.setTimeout(0); // hundreds of blocks: no overall time limit

    fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
    fs.writeFileSync(resultsFile, 'Brand Block ID,Brand Block Name,Result,Fabric Colors,Detail\n');
    test.info().annotations.push({ type: 'results', description: resultsFile });

    await login(page); // once; the same signed-in page is reused for every block

    for (const block of blocks) {
        await test.step(`#${block.id} ${block.name}`, async () => {
            const outcome = await resaveBlock(page, block).catch(
                (e: Error): Outcome => ({ ok: false, colors: '', detail: String(e.message ?? e).split('\n')[0] })
            );
            fs.appendFileSync(
                resultsFile,
                [block.id, block.name, outcome.ok ? 'saved' : 'failed', outcome.colors, outcome.detail].map(csvCell).join(',') + '\n'
            );
            expect.soft(outcome.ok, `#${block.id} ${block.name}: ${outcome.detail}`).toBe(true);
        });
    }
});
