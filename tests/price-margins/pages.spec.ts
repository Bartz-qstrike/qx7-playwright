import { test, expect } from '../fixtures';
import {
    PriceMarginPages,
    expectSortOrderInput,
    getPriceMarginRecords,
    sortOrderText,
} from './helpers/priceMarginPages';

/**
 * Price margin pages (index, add, edit): the sort_order column and field.
 * Nothing is saved: /admin/price_margin/store and /admin/price_margin/update are aborted, and the tests check what
 * the forms would have posted.
 */
test.describe('Price margin pages: sort order (no saving)', () => {
    let pm: PriceMarginPages;

    test.beforeEach(async ({ page }) => {
        pm = new PriceMarginPages(page);
        await pm.blockSaves();
    });

    test.afterEach(async () => {
        pm.expectNoPageErrors();
    });

    test('index: the Sort Order column sits right after Name', async () => {
        await pm.gotoIndex();

        const headers = await pm.indexHeaders();
        const nameIndex = headers.findIndex((h) => /^name$/i.test(h));
        expect(nameIndex, `headers: ${JSON.stringify(headers)}`).toBeGreaterThanOrEqual(0);
        expect(headers[nameIndex + 1]).toMatch(/^sort order$/i);
    });

    test('index: every row shows the sort order saved for it (blank when none)', async ({ request }) => {
        await pm.gotoIndex();
        const records = await getPriceMarginRecords(request);
        const rows = await pm.indexRows();

        expect(rows.length).toBe(records.length);
        for (const record of records) {
            const row = rows.find((r) => r.name === (record.name || '').trim());
            expect(row, `index row for "${record.name}"`).toBeDefined();
            expect(row!.sortOrder, `sort order of "${record.name}"`).toBe(sortOrderText(record.sort_order));
        }
    });

    test('add: the sort order field is an empty whole-number input', async ({ page }) => {
        await pm.gotoAdd();
        const input = pm.addSortOrderInput();

        await expect(page.locator('label[for="price_margin_sort_order"]')).toHaveText(/Sort Order/);
        await expectSortOrderInput(input);
        await expect(input).toHaveValue('');

        await input.pressSequentially('abc');
        await expect(input, 'letters are not accepted').toHaveValue('');
    });

    test('add: SAVE posts the name and the sort order', async () => {
        await pm.gotoAdd();
        await pm.page.locator('#price_margin_name').fill('Playwright not saved');
        await pm.addSortOrderInput().fill('12');

        await pm.submit('create_price_margin');

        const fields = await pm.lastBlockedPost();
        expect(fields).toMatchObject({ name: 'Playwright not saved', sort_order: '12' });
    });

    test('add: SAVE posts an empty sort order when the field is left blank', async () => {
        await pm.gotoAdd();
        await pm.page.locator('#price_margin_name').fill('Playwright not saved');

        await pm.submit('create_price_margin');

        const fields = await pm.lastBlockedPost();
        expect(fields.sort_order).toBe('');
    });

    test('edit: a margin with a sort order is prefilled, and SAVE posts id, name and the new value', async ({ request }) => {
        const withSort = (await getPriceMarginRecords(request)).find((r) => r.sort_order !== null);
        test.skip(!withSort, 'No local price margin has a sort order');

        await pm.gotoEdit(withSort!.id);
        const input = pm.editSortOrderInput();
        await expectSortOrderInput(input);
        await expect(input).toHaveValue(String(withSort!.sort_order));

        await input.fill(String(withSort!.sort_order! + 100));
        await pm.submit('update_price_margin');

        const fields = await pm.lastBlockedPost();
        expect(fields).toMatchObject({
            id: String(withSort!.id),
            name: withSort!.name,
            sort_order: String(withSort!.sort_order! + 100),
        });
    });

    test('edit: a margin without a sort order shows an empty field', async ({ request }) => {
        const withoutSort = (await getPriceMarginRecords(request)).find((r) => r.sort_order === null);
        test.skip(!withoutSort, 'Every local price margin has a sort order');

        await pm.gotoEdit(withoutSort!.id);

        await expectSortOrderInput(pm.editSortOrderInput());
        await expect(pm.editSortOrderInput()).toHaveValue('');
    });
});
