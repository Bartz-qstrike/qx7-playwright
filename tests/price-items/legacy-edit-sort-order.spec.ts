import { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { FACTORY_COST_ID } from './helpers/priceItemCreatePage';
import { PriceItem, PriceItemEditPage, findPriceItem, parseProperties } from './helpers/priceItemEditPage';

/**
 * Legacy price item edit page (/admin/price_item/edit/{id} for a Legacy item, legacy-price-items/edit.blade.php):
 * the pricing table is ordered by price margin sort_order, both for the saved rows (sorted when the page loads) and
 * for price margins added on the page. The non-legacy edit page has its own spec with the same cases:
 * edit-sort-order.spec.ts.
 *
 * Rules (first fabric row):
 *   - Factory Cost is always the first row (it is not part of the sort);
 *   - price margins with a sort_order come next, ascending (equal sort orders by id);
 *   - price margins without a sort_order go to the bottom, ordered by id.
 *
 * The page reads saved rows' sort orders from window.price_margins (inline script) and an added margin's from
 * GET /api/price_margin/{id}. The tests rewrite both in the browser, so they don't depend on (or change) the sort
 * orders saved locally. Factory Cost gets sort_order 999 every time, so a passing test also shows it is not sorted.
 *
 * Nothing is saved: the update URLs are blocked and the save check empties the item name first.
 */

type SortOrders = Record<number, number | null>;

/** Ids of the first fabric's saved price margins, in saved order, Factory Cost excluded. */
function savedMarginIds(item: PriceItem): number[] {
    const first = parseProperties(item)[0];
    return (first?.fabric_price_margin_properties || [])
        .map((entry) => Number(entry.price_margin_properties?.price_margin_id))
        .filter((id) => id && id !== FACTORY_COST_ID);
}

/** A legacy item whose first fabric starts with Factory Cost and has at least 2 more saved price margins. */
function suitable(item: PriceItem): boolean {
    const first = parseProperties(item)[0];
    const entries = first?.fabric_price_margin_properties || [];
    return (
        entries.length > 0 &&
        Number(entries[0].price_margin_properties?.price_margin_id) === FACTORY_COST_ID &&
        savedMarginIds(item).length >= 2
    );
}

/** Expected order: Factory Cost first, then sort_order ascending, then no sort_order; ties by id. */
function expectedOrder(ids: number[], orders: SortOrders): number[] {
    const sortOf = (id: number) => (id in orders ? orders[id] : null);
    const sorted = [...ids].sort((a, b) => {
        const sa = sortOf(a);
        const sb = sortOf(b);
        if (sa !== null && sb !== null && sa !== sb) return sa - sb;
        if ((sa === null) !== (sb === null)) return sa === null ? 1 : -1;
        return a - b;
    });
    return [FACTORY_COST_ID, ...sorted];
}

/** Price margin ids of the first fabric row's pricing table, top to bottom. */
async function tableOrder(page: Page): Promise<number[]> {
    return page
        .locator('.price-margin-fabric-property-row')
        .first()
        .locator('.properties-table tbody tr input.price-margin-info')
        .evaluateAll((inputs) => inputs.map((input) => Number(input.getAttribute('data-price-margin'))));
}

/**
 * Makes the page see the given sort orders (ids not listed keep the real value; `omit` removes the field everywhere,
 * as before the migration): window.price_margins is rewritten as the inline script assigns it, and
 * GET /api/price_margin/{id} responses are rewritten on the way in. Call before opening the page.
 */
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

    // The page sends its GET with `data`, so jQuery appends a query string (e.g. /api/price_margin/16?{"id":16}).
    await page.route(/\/api\/price_margin\/\d+(\?|$)/, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        const pm = body.price_margin;
        if (pm) {
            if (omit) {
                delete pm.sort_order;
            } else if (Number(pm.id) in all) {
                pm.sort_order = all[Number(pm.id)];
            }
        }
        await route.fulfill({ response, json: body });
    });
}

test.describe('Legacy price item edit page: pricing table ordered by sort order', () => {
    let item: PriceItem;
    /** Saved price margins of the first fabric (Factory Cost excluded), in saved order. */
    let saved: number[];
    /** Price margins offered in the first fabric's dropdown that are not on the item yet, lowest id first. */
    let addable: number[];
    let pe: PriceItemEditPage;

    test.beforeEach(async ({ page, request }) => {
        pe = new PriceItemEditPage(page);
        const found = await findPriceItem(request, suitable, true);
        test.skip(!found, 'No local legacy price item has Factory Cost plus 2 saved price margins in its first fabric');
        item = found!;
        saved = savedMarginIds(item);
    });

    test.afterEach(async () => {
        pe.expectNoPageErrors();
    });

    async function open(orders: SortOrders, omit = false) {
        await useSortOrders(pe.page, orders, omit);
        await pe.goto(item.id);
        await expect(pe.page.locator('.price-margin-fabric-property-row').first().locator('tr.non-edit-row')).toHaveCount(1);
        addable = (
            await pe.page.locator('#price-item0 option').evaluateAll((options) =>
                options.map((option) => Number((option as HTMLOptionElement).value))
            )
        )
            .filter((id) => id && id !== FACTORY_COST_ID && !saved.includes(id))
            .sort((a, b) => a - b);
    }

    async function addPriceMargin(id: number) {
        await pe.page.locator('#price-item0').selectOption(String(id));
        await pe.page.locator('.price-margin-fabric-property-row').first().locator('.add-properties-btn').click();
        await expect(pe.priceMarginRow(0, id)).toHaveCount(1);
    }

    test('on load, saved rows are sorted by sort order (here: the reverse of the saved order)', async ({ page }) => {
        const orders: SortOrders = {};
        saved.forEach((id, i) => (orders[id] = saved.length - i)); // last saved gets 1

        await open(orders);

        expect(await tableOrder(page)).toEqual([FACTORY_COST_ID, ...[...saved].reverse()]);
    });

    test('on load, saved rows without a sort order go to the bottom, ordered by id', async ({ page }) => {
        const [first, second, ...rest] = saved;
        const orders: SortOrders = { [first]: null, [second]: null };
        rest.forEach((id, i) => (orders[id] = 10 + i));

        await open(orders);

        expect(await tableOrder(page)).toEqual(expectedOrder(saved, orders));
        const order = await tableOrder(page);
        expect(order.slice(-2)).toEqual([first, second].sort((a, b) => a - b));
    });

    test('without a sort_order field (before the migration) saved rows are ordered by id', async ({ page }) => {
        await open({}, true);

        expect(await tableOrder(page)).toEqual([FACTORY_COST_ID, ...[...saved].sort((a, b) => a - b)]);
    });

    test('an added price margin goes into its sorted place among the saved rows', async ({ page }) => {
        const orders: SortOrders = {};
        saved.forEach((id, i) => (orders[id] = (i + 1) * 10)); // 10, 20, 30, ...
        await open(orders);
        test.skip(addable.length < 1, 'Every price margin is already on this item');
        const added = addable[0];
        orders[added] = 15; // between the first two saved rows
        await page.unrouteAll({ behavior: 'wait' });
        await useSortOrders(page, orders); // the API response for the added margin

        await addPriceMargin(added);

        expect(await tableOrder(page)).toEqual(expectedOrder([...saved, added], orders));
        expect((await tableOrder(page))[2]).toBe(added);
    });

    test('an added price margin without a sort order goes to the bottom', async ({ page }) => {
        const orders: SortOrders = {};
        saved.forEach((id, i) => (orders[id] = i + 1));
        await open(orders);
        test.skip(addable.length < 1, 'Every price margin is already on this item');
        const added = addable[0];
        orders[added] = null;
        await page.unrouteAll({ behavior: 'wait' });
        await useSortOrders(page, orders);

        await addPriceMargin(added);

        const order = await tableOrder(page);
        expect(order).toEqual(expectedOrder([...saved, added], orders));
        expect(order[order.length - 1]).toBe(added);
    });

    test('rebuilding the size columns keeps each row\'s own inputs, values and delete button', async ({ page }) => {
        const orders: SortOrders = {};
        saved.forEach((id, i) => (orders[id] = saved.length - i)); // reversed, so DOM order != saved order
        await open(orders);

        const sizeCount = await pe.sizeInputs(0, saved[0]).count();
        test.skip(sizeCount === 0, 'The item has no size columns');
        const values = new Map<number, string[]>();
        saved.forEach((id, i) => values.set(id, Array.from({ length: sizeCount }, (_, s) => (10 * (i + 1) + s).toFixed(2))));
        for (const [id, sizes] of values) {
            await pe.setSizes(0, id, sizes);
        }

        // Same rebuild the page runs when the selected sizes change: size columns are removed and drawn again per row.
        await page.evaluate(() => (window as any).$('.size-group').first().trigger('change'));
        await expect(pe.sizeInputs(0, saved[0])).toHaveCount(sizeCount);

        expect(await tableOrder(page)).toEqual([FACTORY_COST_ID, ...[...saved].reverse()]);
        for (const [id, sizes] of values) {
            const inputIds = await pe.sizeInputs(0, id).evaluateAll((inputs) => inputs.map((input) => input.id));
            for (const inputId of inputIds) {
                expect(inputId, `size input of price margin ${id}`).toMatch(new RegExp(`-${id}$`));
            }
            expect(await pe.sizeValues(0, id), `sizes of price margin ${id}`).toEqual(sizes);
            await expect(pe.priceMarginRow(0, id).locator('.delete-row')).toHaveAttribute('data-tr-id', String(id));
        }
    });

    test('the properties that would be saved follow the table order', async ({ page }) => {
        const orders: SortOrders = {};
        saved.forEach((id, i) => (orders[id] = saved.length - i));
        await open(orders);
        const order = await tableOrder(page);
        expect(order).toEqual([FACTORY_COST_ID, ...[...saved].reverse()]);

        const fabrics = await pe.readPropertiesToBeSaved();
        expect(
            fabrics[0].fabric_price_margin_properties.map((entry) => Number(entry.price_margin_properties.price_margin_id))
        ).toEqual(order);
    });
});
