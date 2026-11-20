import { Page, Response } from '@playwright/test';
import { test, expect } from '../fixtures';
import { FACTORY_COST_ID } from './helpers/priceItemCreatePage';

/**
 * Price items index page (/admin/price_items): the lines of each PRICING block (one block per fabric) are shown in
 * price margin sort_order, like the pricing table on the create and edit pages:
 *   - the first saved line (Factory Cost) stays first, as on the edit pages;
 *   - price margins with a sort_order come next, ascending (equal sort orders by id);
 *   - price margins without a sort_order go to the bottom, ordered by id.
 *
 * The page only changes what it shows; the saved properties keep their order. Sort orders come from
 * window.price_margins (inline script). The tests rewrite it in the browser (addInitScript setter), so they don't
 * depend on (or change) the sort orders saved locally. Factory Cost gets sort_order 999 every time.
 *
 * Read-only: nothing is clicked besides opening the page.
 */

const INDEX_PATH = '/admin/price_items';
const PAGINATE_URL = '/api/price_items_paginate';

type SortOrders = Record<number, number | null>;

interface SavedEntry {
    sizes?: Record<string, unknown>[];
    price_margin_properties: { price_margin_id: number | string; price_margin_name?: string };
}

interface SavedFabric {
    fabric_name?: string;
    fabric_price_margin_properties?: SavedEntry[];
}

interface IndexRow {
    id: number;
    properties: string | null;
}

interface ShownLine {
    id: number;
    values: string[];
}

interface ShownBlock {
    sizes: string[];
    lines: ShownLine[];
}

const marginId = (entry: SavedEntry) => Number(entry.price_margin_properties?.price_margin_id);

function fabricsOf(row: IndexRow): SavedFabric[] {
    try {
        return JSON.parse(row.properties || '[]') || [];
    } catch {
        return [];
    }
}

/** Expected line order of one fabric: first saved entry pinned, then sort_order ascending, then no sort_order; ties by id. */
function expectedOrder(entries: SavedEntry[], orders: SortOrders): number[] {
    const ids = entries.map(marginId);
    if (ids.length < 3) return ids;
    const sortOf = (id: number) => (id in orders ? orders[id] : null);
    const rest = ids.slice(1).sort((a, b) => {
        const sa = sortOf(a);
        const sb = sortOf(b);
        if (sa !== null && sb !== null && sa !== sb) return sa - sb;
        if ((sa === null) !== (sb === null)) return sa === null ? 1 : -1;
        return a - b;
    });
    return [ids[0], ...rest];
}

/** Makes the page see the given sort orders (ids not listed keep the real value; `omit` removes the field). */
async function useSortOrders(page: Page, orders: SortOrders, omit = false) {
    const all: SortOrders = { [FACTORY_COST_ID]: 999, ...orders };
    await page.addInitScript(
        ({ all, omit }) => {
            let stored: any;
            Object.defineProperty(window, 'price_margins', {
                configurable: true,
                get: () => stored,
                set: (value: any) => {
                    (Array.isArray(value) ? value : []).forEach((pm: any) => {
                        if (omit) {
                            delete pm.sort_order;
                        } else if (String(pm.id) in all) {
                            pm.sort_order = all[pm.id];
                        }
                    });
                    stored = value;
                },
            });
        },
        { all, omit }
    );
}

/** Opens the index page and returns the rows of the first paginate response. */
async function openIndex(page: Page): Promise<IndexRow[]> {
    const first = page.waitForResponse((r: Response) => r.url().includes(PAGINATE_URL));
    await page.goto(INDEX_PATH);
    const response = await first;
    expect(response.ok(), `GET ${response.url()}`).toBeTruthy();
    const body = await response.json();
    expect(body.success, `first paginate response: ${body.errors ?? ''}`).toBe(true);
    await expect(page.locator('#index_price_item_table > tbody > tr').first()).toBeVisible();
    return body.data ?? [];
}

/** The PRICING blocks shown for a price item: size headers, then each line's price margin id and size values. */
async function shownBlocks(page: Page, itemId: number): Promise<ShownBlock[]> {
    const row = page.locator('#index_price_item_table > tbody > tr').filter({
        has: page.locator(`> td input.checkbox_select[data-id="${itemId}"]`),
    });
    await expect(row).toHaveCount(1);
    return row.locator('.pricing-block').evaluateAll((blocks) =>
        blocks.map((block) => {
            const cellsAfterFirst = (tr: Element | null) =>
                Array.from(tr ? tr.children : [])
                    .slice(1)
                    .map((td) => (td.textContent || '').trim());
            // :scope, or the selector also matches through the DataTable around the block.
            const header = block.querySelector(':scope table table tr');
            return {
                sizes: cellsAfterFirst(header),
                lines: Array.from(block.querySelectorAll('td[data-pm-id]')).map((td) => ({
                    id: Number(td.getAttribute('data-pm-id')),
                    values: cellsAfterFirst(td.parentElement),
                })),
            };
        })
    );
}

/** Rows of the first page that have a fabric with at least 3 saved lines (first pinned + 2 that can move). */
function sortableRows(rows: IndexRow[]): IndexRow[] {
    return rows.filter((row) => fabricsOf(row).some((f) => (f.fabric_price_margin_properties || []).length >= 3));
}

test.describe('Price items index page: PRICING lines ordered by sort order', () => {
    let pageErrors: string[];

    test.beforeEach(async ({ page }) => {
        pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
    });

    test.afterEach(async () => {
        expect(pageErrors, 'page errors').toEqual([]);
    });

    /** Opens the page once with the real data, so the tests can pick rows and build sort orders from it. */
    async function firstLook(page: Page): Promise<IndexRow[]> {
        const rows = sortableRows(await openIndex(page));
        test.skip(rows.length === 0, 'No price item on the first page has a fabric with 3 or more pricing lines');
        return rows;
    }

    /** Checks every sortable row on the page against the expected order and its own size values. */
    async function expectRowsOrdered(page: Page, rows: IndexRow[], orders: SortOrders) {
        const all: SortOrders = { [FACTORY_COST_ID]: 999, ...orders };
        for (const row of rows) {
            const fabrics = fabricsOf(row);
            const blocks = await shownBlocks(page, row.id);
            expect(blocks, `pricing blocks of item ${row.id}`).toHaveLength(fabrics.length);
            fabrics.forEach((fabric, f) => {
                const entries = fabric.fabric_price_margin_properties || [];
                expect(
                    blocks[f].lines.map((line) => line.id),
                    `pricing lines of item ${row.id}, fabric ${f}`
                ).toEqual(expectedOrder(entries, all));
            });
        }
    }

    test('lines follow the sort order: the reverse of an item\'s saved order', async ({ page }) => {
        const rows = await firstLook(page);
        const target = rows[0];
        const index = fabricsOf(target).findIndex((f) => (f.fabric_price_margin_properties || []).length >= 3);
        const fabric = fabricsOf(target)[index];
        const moving = fabric.fabric_price_margin_properties!.slice(1).map(marginId);
        const orders: SortOrders = {};
        moving.forEach((id, i) => (orders[id] = moving.length - i)); // last saved gets 1

        await useSortOrders(page, orders);
        const reloaded = sortableRows(await openIndex(page));

        const blocks = await shownBlocks(page, target.id);
        expect(blocks[index].lines.map((line) => line.id)).toEqual([
            marginId(fabric.fabric_price_margin_properties![0]),
            ...[...moving].reverse(),
        ]);
        await expectRowsOrdered(page, reloaded, orders);
    });

    test('lines without a sort order go to the bottom, ordered by id', async ({ page }) => {
        const rows = await firstLook(page);
        const ids = new Set<number>();
        rows.forEach((row) =>
            fabricsOf(row).forEach((f) => (f.fabric_price_margin_properties || []).forEach((e) => ids.add(marginId(e))))
        );
        // Every other price margin (by id) gets no sort order; the rest are sorted highest id first.
        const orders: SortOrders = {};
        [...ids].sort((a, b) => a - b).forEach((id, i) => (orders[id] = i % 2 === 0 ? null : 1000 - id));

        await useSortOrders(page, orders);
        const reloaded = sortableRows(await openIndex(page));

        await expectRowsOrdered(page, reloaded, orders);
        for (const row of reloaded) {
            const blocks = await shownBlocks(page, row.id);
            for (const block of blocks) {
                const tail = block.lines.slice(1).map((line) => line.id);
                const firstUnsorted = tail.findIndex((id) => orders[id] === null);
                if (firstUnsorted < 0) continue;
                const unsorted = tail.slice(firstUnsorted);
                expect(unsorted.every((id) => orders[id] === null), `unsorted lines last in item ${row.id}`).toBe(true);
                expect(unsorted).toEqual([...unsorted].sort((a, b) => a - b));
            }
        }
    });

    test('without a sort_order field (before the migration) the lines are ordered by id', async ({ page }) => {
        await firstLook(page);
        await useSortOrders(page, {}, true);
        const reloaded = sortableRows(await openIndex(page));

        for (const row of reloaded) {
            const blocks = await shownBlocks(page, row.id);
            fabricsOf(row).forEach((fabric, f) => {
                const ids = (fabric.fabric_price_margin_properties || []).map(marginId);
                expect(blocks[f].lines.map((line) => line.id), `item ${row.id}, fabric ${f}`).toEqual([
                    ids[0],
                    ...ids.slice(1).sort((a, b) => a - b),
                ]);
            });
        }
    });

    test('each line keeps its own size values after reordering', async ({ page }) => {
        const rows = await firstLook(page);
        const target = rows[0];
        const orders: SortOrders = {};
        fabricsOf(target).forEach((f) => {
            const moving = (f.fabric_price_margin_properties || []).slice(1).map(marginId);
            moving.forEach((id, i) => (orders[id] = moving.length - i));
        });

        await useSortOrders(page, orders);
        await openIndex(page);

        const blocks = await shownBlocks(page, target.id);
        fabricsOf(target).forEach((fabric, f) => {
            for (const entry of fabric.fabric_price_margin_properties || []) {
                const saved: Record<string, string> = {};
                (entry.sizes || []).forEach((size) =>
                    Object.entries(size).forEach(([name, value]) => (saved[name] = value == null ? '' : String(value)))
                );
                const line = blocks[f].lines.find((l) => l.id === marginId(entry));
                expect(line, `line of price margin ${marginId(entry)}`).toBeTruthy();
                expect(line!.values, `sizes of price margin ${marginId(entry)} (item ${target.id}, fabric ${f})`).toEqual(
                    blocks[f].sizes.map((size) => (saved[size] ?? '').trim())
                );
            }
        });
    });

    test('pricing blocks still line up with the PRIMARY FABRIC column', async ({ page }) => {
        const rows = await firstLook(page);
        const orders: SortOrders = {};
        await useSortOrders(page, orders);
        await openIndex(page);

        for (const row of rows) {
            const tr = page.locator('#index_price_item_table > tbody > tr').filter({
                has: page.locator(`> td input.checkbox_select[data-id="${row.id}"]`),
            });
            const fabricCount = fabricsOf(row).length;
            await expect(tr.locator('.pricing-block')).toHaveCount(fabricCount);
            await expect(tr.locator('.primary-fabric-block')).toHaveCount(fabricCount);
        }
    });
});
