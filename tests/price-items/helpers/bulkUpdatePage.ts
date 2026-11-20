import { expect, Locator, Page } from '@playwright/test';

/**
 * Page helpers for the price items bulk update page (/admin/price_items/bulk_update).
 *
 * The page lists price items with a row for the selected price margin. Only the "Formula Dependent Price Items"
 * table (rows with QC on) has a working Adjust: it posts to /api/price_items/update/bulk with auto = 1. The server
 * changes the selected price margin's sizes, turns its QC off, and recomputes the QC-on rows whose formula uses it.
 *
 * Adjust REALLY SAVES: only used by the end-to-end flow (tests/e2e).
 */
export class BulkUpdatePage {
    readonly pageErrors: Error[] = [];

    constructor(readonly page: Page) {
        page.on('pageerror', (error) => this.pageErrors.push(error));
    }

    async goto() {
        await this.page.goto('/admin/price_items/bulk_update');
        await expect(this.page.locator('.search-btn')).toBeVisible();
        // The page loads every price item synchronously on start (window.price_items)
        await expect.poll(() => this.page.evaluate(() => Array.isArray((window as any).price_items))).toBe(true);
    }

    /** Brand and price margin filters, then SEARCH. */
    async search(brandId: string, priceMarginId: number) {
        await this.page.locator('#brand-id').selectOption(brandId);
        await this.page.locator('#price-margin').selectOption(String(priceMarginId));
        await this.page.locator('.search-btn').click();
    }

    dependentCheckbox(priceItemId: number): Locator {
        return this.page.locator(`#dependent-table input.dep-cb[value="${priceItemId}"]`);
    }

    /** Ticks the given items in the dependent table, sets the adjustment and confirms it in the modal. */
    async adjustDependent(priceItemIds: number[], amount: string, type: 'fixed' | 'percentage') {
        for (const id of priceItemIds) {
            await this.dependentCheckbox(id).check();
        }
        await this.page.locator('#amount-dep').fill(amount);
        await this.page.locator('#computation-type-dep').selectOption(type);

        const response = this.page.waitForResponse((r) => r.url().includes('/api/price_items/update/bulk'));
        await this.page.locator('#modal-btn-dep').click();
        await expect(this.page.locator('#confirmationAdjustmentModal')).toBeVisible();
        await this.page.locator('#adjust-btn-dep').click();
        const body = await (await response).json();
        expect(body.success, JSON.stringify(body)).toBe(true);
        return body as { success: boolean; updated: string[]; errors: string[] };
    }

    expectNoPageErrors() {
        expect(this.pageErrors.map((error) => error.message), 'JavaScript errors on the page').toEqual([]);
    }
}
