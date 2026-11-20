import { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { FACTORY_COST_ID, PRICE_ITEM_CREATE_PAGE, PriceItemCreatePage } from './helpers/priceItemCreatePage';

/**
 * Price item create page (/admin/price_items/add): the pricing table is ordered by price margin sort_order.
 * The legacy page has its own spec with the same cases: legacy-create-sort-order.spec.ts.
 *
 * Rules (first fabric row):
 *   - Factory Cost is always the first row (it is not part of the sort);
 *   - added price margins with a sort_order come next, ascending (equal sort orders by id);
 *   - added price margins without a sort_order go to the bottom, ordered by id.
 *
 * The sort orders come from GET /api/price_margin/{id}, which the page calls when a price margin is added. The tests
 * rewrite that response in the browser, so they don't depend on (or change) the sort orders saved locally.
 * Factory Cost gets a large sort_order (999) in every test, so a passing test also shows it is not sorted.
 *
 * Nothing is saved: the store URL is blocked and the item name is left empty.
 */

type SortOrder = number | null;

/** Sort orders the page will see, by price margin id. Ids not listed keep the real value. */
let sortOrders: Map<number, SortOrder>;
/** When true, the sort_order field is removed from the response (as before the migration). */
let omitSortOrder: boolean;

async function rewritePriceMarginResponses(page: Page) {
    // The page sends its GET with `data`, so jQuery appends a query string (e.g. /api/price_margin/16?{"id":16}).
    await page.route(/\/api\/price_margin\/\d+(\?|$)/, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        const pm = body.price_margin;
        if (pm) {
            if (omitSortOrder) {
                delete pm.sort_order;
            } else if (sortOrders.has(Number(pm.id))) {
                pm.sort_order = sortOrders.get(Number(pm.id));
            }
        }
        await route.fulfill({ response, json: body });
    });
}

/** Price margin ids of the first fabric row's pricing table, top to bottom. */
async function tableOrder(page: Page): Promise<number[]> {
    return page
        .locator('.price-margin-fabric-property-row')
        .first()
        .locator('.properties-table tbody tr.size_rows input.price-margin-info')
        .evaluateAll((inputs) => inputs.map((input) => Number(input.getAttribute('data-price-margin'))));
}

/** Expected order: Factory Cost first, then sort_order ascending, then no sort_order; ties by id. */
function expectedOrder(added: number[], orders: Map<number, SortOrder>): number[] {
    const sortOf = (id: number) => (orders.has(id) ? orders.get(id)! : null);
    const sorted = [...added].sort((a, b) => {
        const sa = sortOf(a);
        const sb = sortOf(b);
        if (sa !== null && sb !== null && sa !== sb) return sa - sb;
        if ((sa === null) !== (sb === null)) return sa === null ? 1 : -1;
        return a - b;
    });
    return [FACTORY_COST_ID, ...sorted];
}

test.describe('Price item create page: pricing table ordered by sort order', () => {
    let pi: PriceItemCreatePage;
    /** Price margins that can be added to the first fabric row (Factory Cost excluded), lowest id first. */
    let available: number[];
    let sizeCount: number;

    test.beforeEach(async ({ page }) => {
        sortOrders = new Map([[FACTORY_COST_ID, 999]]);
        omitSortOrder = false;
        await rewritePriceMarginResponses(page);

        pi = new PriceItemCreatePage(page, PRICE_ITEM_CREATE_PAGE.path);
        await pi.goto();

        sizeCount = 0;
        for (const brandId of await pi.brandIds()) {
            await pi.selectBrand(brandId);
            sizeCount = (await pi.selectSportWithSizes()).sizes;
            if (sizeCount > 0) break;
        }
        test.skip(sizeCount === 0, 'No brand and sport give the page a size group with sizes');

        available = (await pi.selectablePriceMarginIds())
            .filter((id) => id !== FACTORY_COST_ID)
            .sort((a, b) => a - b);
        test.skip(available.length < 5, 'Needs at least 5 price margins besides Factory Cost');
    });

    test.afterEach(async () => {
        pi.expectNoPageErrors();
    });

    /** Adds the price margins one by one, in the given order. */
    async function addAll(ids: number[]) {
        for (const id of ids) {
            await pi.addPriceMargin(id);
        }
    }

    test('price margins with a sort order are listed ascending, whatever order they are added in', async ({ page }) => {
        const [a, b, c, d] = available;
        sortOrders.set(a, 4).set(b, 1).set(c, 3).set(d, 2);

        await addAll([a, c, d, b]);

        expect(await tableOrder(page)).toEqual([FACTORY_COST_ID, b, d, c, a]);
    });

    test('a price margin added after the others still goes into its sorted place', async ({ page }) => {
        const [a, b, c] = available;
        sortOrders.set(a, 10).set(b, 30).set(c, 20);

        await addAll([a, b]);
        expect(await tableOrder(page)).toEqual([FACTORY_COST_ID, a, b]);

        await pi.addPriceMargin(c); // belongs between a and b
        expect(await tableOrder(page)).toEqual([FACTORY_COST_ID, a, c, b]);
    });

    test('a sort order of 0 is a real sort order, not "no sort order"', async ({ page }) => {
        const [a, b, c] = available;
        sortOrders.set(a, null).set(b, 5).set(c, 0);

        await addAll([a, b, c]);

        expect(await tableOrder(page)).toEqual([FACTORY_COST_ID, c, b, a]);
    });

    test('a price margin without a sort order goes to the bottom', async ({ page }) => {
        const [a, b, c] = available;
        sortOrders.set(a, null).set(b, 2).set(c, 1);

        await addAll([a, b, c]); // the unsorted one is added first

        expect(await tableOrder(page)).toEqual([FACTORY_COST_ID, c, b, a]);
    });

    test('several price margins without a sort order go to the bottom, ordered by id', async ({ page }) => {
        const [a, b, c, d, e] = available; // ascending ids
        sortOrders.set(a, null).set(b, 7).set(c, null).set(d, null).set(e, 3);

        await addAll([d, b, a, e, c]);

        expect(await tableOrder(page)).toEqual([FACTORY_COST_ID, e, b, a, c, d]);
    });

    test('price margins with the same sort order are ordered by id', async ({ page }) => {
        const [a, b, c] = available;
        sortOrders.set(a, 5).set(b, 5).set(c, 1);

        await addAll([b, a, c]);

        expect(await tableOrder(page)).toEqual([FACTORY_COST_ID, c, a, b]);
    });

    test('Factory Cost stays the first row, even with the largest sort order', async ({ page }) => {
        const ids = available.slice(0, 4);
        ids.forEach((id, i) => sortOrders.set(id, i % 2 === 0 ? i : null)); // a mix of sorted and unsorted

        await addAll([...ids].reverse());

        const order = await tableOrder(page);
        expect(order[0]).toBe(FACTORY_COST_ID);
        expect(order).toEqual(expectedOrder(ids, sortOrders));
    });

    test('without a sort_order field (before the migration) the added rows are ordered by id', async ({ page }) => {
        omitSortOrder = true;
        const [a, b, c] = available;

        await addAll([c, a, b]);

        expect(await tableOrder(page)).toEqual([FACTORY_COST_ID, a, b, c]);
    });

    test('rebuilding the size columns keeps each row\'s own inputs, values and delete button', async ({ page }) => {
        const [a, b, c] = available;
        sortOrders.set(a, 3).set(b, 1).set(c, 2);
        await addAll([a, b, c]); // added a, b, c; shown b, c, a

        const values = new Map<number, string[]>([
            [a, Array.from({ length: sizeCount }, (_, i) => (10 + i).toFixed(2))],
            [b, Array.from({ length: sizeCount }, (_, i) => (20 + i).toFixed(2))],
            [c, Array.from({ length: sizeCount }, (_, i) => (30 + i).toFixed(2))],
        ]);
        for (const [id, sizes] of values) {
            await pi.setSizes(id, sizes);
        }

        // Same rebuild the page runs when the selected sizes change: size columns are removed and drawn again per row.
        await page.evaluate(() => (window as any).$('.size-group').first().trigger('change'));
        await expect(pi.sizeInputs(a)).toHaveCount(sizeCount);

        expect(await tableOrder(page)).toEqual([FACTORY_COST_ID, b, c, a]);
        for (const [id, sizes] of values) {
            const inputIds = await pi.sizeInputs(id).evaluateAll((inputs) => inputs.map((input) => input.id));
            for (const inputId of inputIds) {
                expect(inputId, `size input of price margin ${id}`).toMatch(new RegExp(`-${id}$`));
            }
            expect(await pi.sizeValues(id), `sizes of price margin ${id}`).toEqual(sizes);
            await expect(pi.priceMarginRow(id).locator('.delete-row')).toHaveAttribute('data-tr-id', String(id));
        }
    });

    test('the properties that would be saved follow the table order', async ({ page }) => {
        const [a, b, c, d] = available;
        sortOrders.set(a, null).set(b, 2).set(c, 1).set(d, null);

        await addAll([d, a, b, c]);
        const order = await tableOrder(page);
        expect(order).toEqual([FACTORY_COST_ID, c, b, a, d]);

        const entries = await pi.readPropertiesToBeSaved();
        expect(entries.map((entry) => Number(entry.price_margin_properties.price_margin_id))).toEqual(order);
    });
});
