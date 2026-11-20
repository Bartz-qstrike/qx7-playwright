import { Page, Response } from '@playwright/test';
import { test, expect } from '../fixtures';

/**
 * Price items index page (/admin/price_items): the TYPE column (BA / Legacy) between PRICING and ACTIVE.
 *
 * The datatable is server-side: sorting sends the clicked column's index (order[0][column]) and
 * MasterPriceItemsDAO::getMasterPriceItemsPaginate maps it through $staticTableColumns
 * (8 = pricing placeholder, 9 = master_price_items.type, 10 = master_price_items.active).
 *
 * Read-only: no toggle, duplicate, delete or export is clicked.
 */

const INDEX_PATH = '/admin/price_items';
const PAGINATE_URL = '/api/price_items_paginate';
const TYPE_COLUMN_INDEX = 9;
const ACTIVE_COLUMN_INDEX = 10;

interface IndexRow {
    id: number;
    type: string | null;
    active: number | boolean | null;
}

interface PaginateResult {
    params: URLSearchParams;
    body: { success: boolean; data?: IndexRow[]; errors?: string };
}

/** Waits for the next /api/price_items_paginate response whose request params pass `accept`. */
async function waitForPaginate(page: Page, accept: (params: URLSearchParams) => boolean = () => true): Promise<PaginateResult> {
    const response: Response = await page.waitForResponse((r) => {
        if (!r.url().includes(PAGINATE_URL)) {
            return false;
        }
        return accept(new URL(r.url()).searchParams);
    });
    expect(response.ok(), `GET ${response.url()}`).toBeTruthy();
    return { params: new URL(response.url()).searchParams, body: await response.json() };
}

/** Opens the index page and returns the first paginate response. */
async function openIndex(page: Page): Promise<PaginateResult> {
    const first = waitForPaginate(page);
    await page.goto(INDEX_PATH);
    const result = await first;
    expect(result.body.success, `first paginate response: ${result.body.errors ?? ''}`).toBe(true);
    await expect(page.locator('#index_price_item_table > tbody > tr').first()).toBeVisible();
    return result;
}

/** The visible header (DataTables with scrollX renders it in .dataTables_scrollHead). */
function headerCells(page: Page) {
    return page.locator('.dataTables_scrollHead thead th');
}

async function headerTexts(page: Page): Promise<string[]> {
    return (await headerCells(page).allInnerTexts()).map((text) => text.trim());
}

function headerCell(page: Page, title: string) {
    return headerCells(page).filter({ hasText: new RegExp(`^\\s*${title}\\s*$`) });
}

/**
 * Data rows only: direct rows of the table's own tbody (the PRICING cell holds nested tables with their own rows),
 * without the single td.dataTables_empty row DataTables shows when there is nothing.
 */
function bodyRows(page: Page) {
    return page
        .locator('#index_price_item_table > tbody > tr')
        .filter({ hasNot: page.locator('> td.dataTables_empty') });
}

/** Text of the TYPE cell in each body row, found by the TYPE header's position. */
async function typeCells(page: Page): Promise<string[]> {
    const typeIndex = (await headerTexts(page)).indexOf('TYPE');
    expect(typeIndex, 'TYPE header index').toBeGreaterThanOrEqual(0);
    const rows = bodyRows(page);
    const texts: string[] = [];
    for (let i = 0; i < (await rows.count()); i++) {
        texts.push((await rows.nth(i).locator('> td').nth(typeIndex).innerText()).trim());
    }
    return texts;
}

const typeText = (row: IndexRow) => row.type ?? '';

function expectOrdered<T>(values: T[], dir: 'asc' | 'desc', label: string) {
    for (let i = 1; i < values.length; i++) {
        const [prev, next] = [values[i - 1], values[i]];
        const ok = dir === 'asc' ? prev <= next : prev >= next;
        expect(ok, `${label} ${dir} at row ${i}: ${JSON.stringify(prev)} then ${JSON.stringify(next)}`).toBe(true);
    }
}

/** Clicks a header and returns the paginate response that sorts by `columnIndex` in `dir`. */
async function sortBy(page: Page, title: string, columnIndex: number, dir: 'asc' | 'desc'): Promise<PaginateResult> {
    const response = waitForPaginate(
        page,
        (params) => params.get('order[0][column]') === String(columnIndex) && params.get('order[0][dir]') === dir
    );
    await headerCell(page, title).click();
    const result = await response;
    expect(result.body.success, `sort by ${title} ${dir}: ${result.body.errors ?? ''}`).toBe(true);
    return result;
}

test.describe('Price items index page – TYPE column', () => {
    test('TYPE header sits between PRICING and ACTIVE', async ({ page }) => {
        await openIndex(page);

        const headers = await headerTexts(page);
        expect(headers.filter((h) => h === 'TYPE'), `headers: ${headers.join(' | ')}`).toHaveLength(1);

        const typeIndex = headers.indexOf('TYPE');
        expect(headers[typeIndex - 1], 'header before TYPE').toBe('PRICING');
        expect(headers[typeIndex + 1], 'header after TYPE').toBe('ACTIVE');
        expect(typeIndex, 'TYPE column index sent to the server').toBe(TYPE_COLUMN_INDEX);
        expect(headers.indexOf('ACTIVE'), 'ACTIVE column index sent to the server').toBe(ACTIVE_COLUMN_INDEX);

        const rows = bodyRows(page);
        const rowCount = await rows.count();
        for (let i = 0; i < rowCount; i++) {
            await expect(rows.nth(i).locator('> td'), `cells in row ${i}`).toHaveCount(headers.length);
        }
    });

    test('each row shows its price item type', async ({ page }) => {
        const { body } = await openIndex(page);
        const data = body.data ?? [];
        test.skip(data.length === 0, 'No price items in the local data.');

        await expect.poll(() => typeCells(page)).toEqual(data.map(typeText));
    });

    for (const value of ['BA', 'Legacy']) {
        test(`Types filter "${value}" only shows ${value} rows`, async ({ page }) => {
            await openIndex(page);

            await page.locator('#types').selectOption(value);
            const response = waitForPaginate(page, (params) => params.get('types') === value);
            await page.locator('a.filter-all', { hasText: 'FILTER' }).click();
            const { body } = await response;
            expect(body.success, `filter ${value}: ${body.errors ?? ''}`).toBe(true);

            const data = body.data ?? [];
            test.skip(data.length === 0, `No ${value} price items in the local data.`);

            expect(data.map(typeText), 'types returned by the API').toEqual(data.map(() => value));
            await expect.poll(() => typeCells(page)).toEqual(data.map(() => value));
        });
    }

    test('sorting by TYPE orders rows by type', async ({ page }) => {
        const { body } = await openIndex(page);
        test.skip((body.data ?? []).length === 0, 'No price items in the local data.');

        const asc = await sortBy(page, 'TYPE', TYPE_COLUMN_INDEX, 'asc');
        const ascTypes = (asc.body.data ?? []).map((row) => typeText(row).toLowerCase());
        expectOrdered(ascTypes, 'asc', 'type');
        await expect.poll(() => typeCells(page)).toEqual((asc.body.data ?? []).map(typeText));

        const desc = await sortBy(page, 'TYPE', TYPE_COLUMN_INDEX, 'desc');
        const descTypes = (desc.body.data ?? []).map((row) => typeText(row).toLowerCase());
        expectOrdered(descTypes, 'desc', 'type');
        await expect.poll(() => typeCells(page)).toEqual((desc.body.data ?? []).map(typeText));
    });

    test('sorting by ACTIVE still works after the column moved', async ({ page }) => {
        const { body } = await openIndex(page);
        test.skip((body.data ?? []).length === 0, 'No price items in the local data.');

        const asc = await sortBy(page, 'ACTIVE', ACTIVE_COLUMN_INDEX, 'asc');
        expectOrdered((asc.body.data ?? []).map((row) => Number(row.active)), 'asc', 'active');

        const desc = await sortBy(page, 'ACTIVE', ACTIVE_COLUMN_INDEX, 'desc');
        expectOrdered((desc.body.data ?? []).map((row) => Number(row.active)), 'desc', 'active');
    });
});
