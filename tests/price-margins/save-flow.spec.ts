import { test, expect } from '../fixtures';
import { PriceMarginPages, findPriceMarginByName } from './helpers/priceMarginPages';

/**
 * Price margin pages, SAVING for real: add a price margin with a sort order, change it, clear it, then delete it from
 * the index. The tests run in order and share one margin named "Playwright PM <YYYY-MM-DD HH:mm:ss>".
 *
 * The name is never changed: renaming a margin starts jobs that rewrite price items, add-ons and formulas.
 * Cleanup: afterAll deletes the margin through the API if a failed step left it behind. Deletes are soft deletes,
 * so a trashed row stays in the database (as with any delete from the admin).
 */

function timestamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

test.describe.serial('Price margin pages: sort order save flow (SAVES)', () => {
    const name = `Playwright PM ${timestamp()}`;
    let id: number | undefined;

    test.afterAll(async ({ browser }) => {
        const context = await browser.newContext({ storageState: '.auth/admin.json' });
        const page = await context.newPage();
        try {
            const leftover = await findPriceMarginByName(page.request, name);
            if (leftover) {
                // Same call as the index's delete button, with the signed-in admin's API token.
                await page.goto('/admin/price_margins');
                const result = await page.evaluate(async (leftoverId) => {
                    const token = atob((window as any).headerValue);
                    const response = await fetch('/api/price_margin/delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                        body: JSON.stringify({ id: leftoverId }),
                    });
                    return response.json();
                }, leftover.id);
                console.log(`Cleanup: deleted leftover price margin ${leftover.id} "${name}":`, JSON.stringify(result));
            }
        } finally {
            await context.close();
        }
    });

    test('add a price margin with sort order 7', async ({ page, request }) => {
        console.log(`Price margin used by this run: "${name}"`);
        const pm = new PriceMarginPages(page);

        await pm.gotoAdd();
        await page.locator('#price_margin_name').fill(name);
        await pm.addSortOrderInput().fill('7');
        await pm.submitAndWaitForIndex('create_price_margin');

        await expect(pm.indexRow(name)).toHaveCount(1);
        expect(await pm.indexSortOrderCell(name)).toBe('7');

        const saved = await findPriceMarginByName(request, name);
        expect(saved, 'the API lists the new price margin').toBeDefined();
        expect(saved!.sort_order).toBe(7);
        id = saved!.id;
        pm.expectNoPageErrors();
    });

    test('edit: the field shows 7; change it to 3', async ({ page, request }) => {
        test.skip(!id, 'The add step did not create the price margin');
        const pm = new PriceMarginPages(page);

        await pm.gotoEdit(id!);
        await expect(page.locator('#name')).toHaveValue(name);
        await expect(pm.editSortOrderInput()).toHaveValue('7');

        await pm.editSortOrderInput().fill('3');
        await pm.submitAndWaitForIndex('update_price_margin');

        expect(await pm.indexSortOrderCell(name)).toBe('3');
        const saved = await findPriceMarginByName(request, name);
        expect(saved).toMatchObject({ id, name, sort_order: 3 });
        pm.expectNoPageErrors();
    });

    test('edit: clearing the field saves no sort order', async ({ page, request }) => {
        test.skip(!id, 'The add step did not create the price margin');
        const pm = new PriceMarginPages(page);

        await pm.gotoEdit(id!);
        await expect(pm.editSortOrderInput()).toHaveValue('3');

        await pm.editSortOrderInput().fill('');
        await pm.submitAndWaitForIndex('update_price_margin');

        expect(await pm.indexSortOrderCell(name)).toBe('');
        const saved = await findPriceMarginByName(request, name);
        expect(saved).toMatchObject({ id, name, sort_order: null });
        pm.expectNoPageErrors();
    });

    test('delete it from the index', async ({ page, request }) => {
        test.skip(!id, 'The add step did not create the price margin');
        const pm = new PriceMarginPages(page);

        await pm.gotoIndex();
        await pm.deleteFromIndex(name);

        await expect(pm.indexRow(name)).toHaveCount(0);
        expect(await findPriceMarginByName(request, name), 'the API no longer lists it').toBeUndefined();
        pm.expectNoPageErrors();
    });
});
