import { APIRequestContext, expect, Locator, Page, Request } from '@playwright/test';

/**
 * Helpers for the price margin admin pages:
 *   index  /admin/price_margins            (datatable: Name, Sort Order, actions)
 *   add    /admin/price_margin/add         (#price_margin_name, #price_margin_sort_order)
 *   edit   /admin/price_margin/edit/{id}   (#name, #sort_order, hidden id)
 * The add/edit forms post to /admin/price_margin/store and /admin/price_margin/update (web routes), whose controller
 * calls the API. Unless a page is opened with `save: true`, those two URLs are aborted and their posted fields recorded.
 */

export interface PriceMarginRecord {
    id: number;
    name: string;
    sort_order: number | null;
}

export const STORE_URL = '**/admin/price_margin/store';
export const UPDATE_URL = '**/admin/price_margin/update';

/** All active price margins, from the public API. */
export async function getPriceMarginRecords(request: APIRequestContext): Promise<PriceMarginRecord[]> {
    const response = await request.get('/api/price_margins');
    expect(response.ok(), 'GET /api/price_margins').toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);
    return body.price_margins;
}

export async function findPriceMarginByName(request: APIRequestContext, name: string): Promise<PriceMarginRecord | undefined> {
    return (await getPriceMarginRecords(request)).find((pm) => pm.name === name);
}

/** The fields of a multipart form post (the forms use enctype="multipart/form-data"). */
export function formFields(request: Request): Record<string, string> {
    const body = request.postData() || '';
    const fields: Record<string, string> = {};
    const re = /name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
        fields[match[1]] = match[2];
    }
    return fields;
}

export class PriceMarginPages {
    /** Posted fields of every blocked store/update request. */
    readonly blockedPosts: { url: string; fields: Record<string, string> }[] = [];
    readonly pageErrors: Error[] = [];

    constructor(readonly page: Page) {
        page.on('pageerror', (error) => this.pageErrors.push(error));
    }

    /** Aborts form saves and records what they would have posted. */
    async blockSaves() {
        for (const url of [STORE_URL, UPDATE_URL]) {
            await this.page.route(url, async (route) => {
                this.blockedPosts.push({ url: route.request().url(), fields: formFields(route.request()) });
                await route.abort();
            });
        }
    }

    // ---------- index ----------

    async gotoIndex() {
        await this.page.goto('/admin/price_margins');
        await expect(this.page.locator('#price_margin_table')).toBeVisible();
    }

    /** Header texts of the datatable (DataTables copies the header into .dataTables_scrollHead). */
    async indexHeaders(): Promise<string[]> {
        const head = this.page.locator('.dataTables_scrollHead thead th');
        const cells = (await head.count()) > 0 ? head : this.page.locator('#price_margin_table thead th');
        return cells.evaluateAll((ths) => ths.map((th) => (th.textContent || '').trim()));
    }

    /** Name -> Sort Order cell text, for every row on the index. */
    async indexRows(): Promise<{ name: string; sortOrder: string }[]> {
        return this.page.locator('#price_margin_table tbody tr').evaluateAll((trs) =>
            trs
                .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim()))
                .filter((cells) => cells.length >= 3)
                .map((cells) => ({ name: cells[0], sortOrder: cells[1] }))
        );
    }

    indexRow(name: string): Locator {
        return this.page
            .locator('#price_margin_table tbody tr')
            .filter({ has: this.page.locator('td:first-child', { hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`) }) });
    }

    async indexSortOrderCell(name: string): Promise<string> {
        return ((await this.indexRow(name).locator('td').nth(1).textContent()) || '').trim();
    }

    /** Clicks the row's trash icon, waits for the confirmation modal and confirms. */
    async deleteFromIndex(name: string) {
        await this.indexRow(name).locator('.delete-record').click();
        const yes = this.page.locator('#confirmation-modal .confirm-yes');
        await expect(yes).toBeVisible();
        await expect(yes).toBeEnabled();
        await Promise.all([this.page.waitForEvent('load'), yes.click()]);
    }

    // ---------- add / edit ----------

    async gotoAdd() {
        await this.page.goto('/admin/price_margin/add');
        await expect(this.page.locator('#create_price_margin')).toBeVisible();
    }

    async gotoEdit(id: number) {
        await this.page.goto(`/admin/price_margin/edit/${id}`);
        await expect(this.page.locator('#update_price_margin')).toBeVisible();
    }

    addSortOrderInput(): Locator {
        return this.page.locator('#price_margin_sort_order');
    }

    editSortOrderInput(): Locator {
        return this.page.locator('#sort_order');
    }

    async submit(formId: 'create_price_margin' | 'update_price_margin') {
        await this.page.locator(`#${formId} button[type="submit"]`).click();
    }

    /** Clicks SAVE on a page opened for real and waits for the redirect back to the index. */
    async submitAndWaitForIndex(formId: 'create_price_margin' | 'update_price_margin') {
        await Promise.all([this.page.waitForURL('**/admin/price_margins'), this.submit(formId)]);
    }

    /** Waits until a blocked save has been recorded and returns its posted fields. */
    async lastBlockedPost(): Promise<Record<string, string>> {
        await expect.poll(() => this.blockedPosts.length, { message: 'a blocked save request' }).toBeGreaterThan(0);
        return this.blockedPosts[this.blockedPosts.length - 1].fields;
    }

    expectNoPageErrors() {
        expect(this.pageErrors.map((error) => error.message), 'JavaScript errors on the page').toEqual([]);
    }
}

/** Expects a number input that only takes whole numbers from 0 up. */
export async function expectSortOrderInput(input: Locator) {
    await expect(input).toHaveAttribute('type', 'number');
    await expect(input).toHaveAttribute('name', 'sort_order');
    await expect(input).toHaveAttribute('min', '0');
    await expect(input).toHaveAttribute('step', '1');
}

/** Index cell text for a sort order: the number, or blank for null. */
export function sortOrderText(sortOrder: number | null | undefined): string {
    return sortOrder === null || sortOrder === undefined ? '' : String(sortOrder);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
