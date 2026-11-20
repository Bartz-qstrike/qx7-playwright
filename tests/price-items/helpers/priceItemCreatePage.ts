import { expect, Locator, Page } from '@playwright/test';

export const FACTORY_COST_ID = 9;

export interface SavedPricingEntry {
    qc_required: number;
    formula: string | null;
    formula_id: number | null;
    price_margin_properties: { price_margin_id: number; price_margin_name: string };
    sizes: Record<string, string>[];
}

/**
 * Page helpers for the price item create pages, first fabric row (row 0). Both pages share the same controls.
 *
 * Never saves: every request to the store URL is aborted and recorded (see `saveAttempts`), and
 * `readPropertiesToBeSaved()` only lets the page build its `properties` JSON (the click stops at the
 * required-field check because the item name is left empty).
 */
export interface CreatePage {
    name: string;
    path: string;
}

export const PRICE_ITEM_CREATE_PAGE: CreatePage = { name: 'Price item create page', path: '/admin/price_items/add' };
export const LEGACY_PRICE_ITEM_CREATE_PAGE: CreatePage = {
    name: 'Legacy price item create page',
    path: '/admin/price_item/add_legacy',
};

export class PriceItemCreatePage {
    readonly pageErrors: Error[] = [];
    readonly saveAttempts: string[] = [];

    constructor(readonly page: Page, readonly path = PRICE_ITEM_CREATE_PAGE.path, readonly fabricRow = 0) {
        page.on('pageerror', (error) => this.pageErrors.push(error));
    }

    /** `save: true` leaves the store URL open: only for the end-to-end flow (tests/e2e), which really saves. */
    async goto(options: { save?: boolean } = {}) {
        if (!options.save) {
            await this.page.route('**/admin/price_item/store', async (route) => {
                this.saveAttempts.push(route.request().url());
                await route.abort();
            });
        }
        await this.page.goto(this.path);
        await expect(this.priceMarginRow(FACTORY_COST_ID)).toBeAttached();
    }

    async brandIds(): Promise<string[]> {
        return this.page.locator('#brand_id option').evaluateAll((options) =>
            options.map((option) => (option as HTMLOptionElement).value)
        );
    }

    async selectBrand(brandId: string) {
        await this.page.locator('#brand_id').selectOption(brandId);
        await this.page.locator('#brand_id').dispatchEvent('change');
    }

    /**
     * Sport is a select2 multi-select; set it through jQuery like the page's own code does.
     * Tries `preferred` first, then every sport in order, until the Factory Cost row gets size columns.
     * Returns the sport used and the number of sizes (0 if none works).
     */
    async selectSportWithSizes(preferred?: string): Promise<{ sport: string | null; sizes: number }> {
        const sports = await this.page.locator('#sport option').evaluateAll((options) =>
            options.map((option) => (option as HTMLOptionElement).value)
        );
        const ordered = preferred ? [preferred, ...sports.filter((s) => s !== preferred)] : sports;
        for (const sport of ordered) {
            await this.page.evaluate((value) => {
                const $ = (window as any).$;
                $('#sport').val([value]).trigger('change');
            }, sport);
            const sizes = await this.sizeInputs(FACTORY_COST_ID).count();
            if (sizes > 0) {
                return { sport, sizes };
            }
        }
        return { sport: null, sizes: 0 };
    }

    /** Price margins offered in the fabric row's "add price margin" dropdown. */
    async selectablePriceMarginIds(): Promise<number[]> {
        return this.page.locator(`#price-item${this.fabricRow} option`).evaluateAll((options) =>
            options.map((option) => Number((option as HTMLOptionElement).value))
        );
    }

    async addPriceMargin(priceMarginId: number) {
        await this.page.locator(`#price-item${this.fabricRow}`).selectOption(String(priceMarginId));
        await this.page
            .locator('.price-margin-fabric-property-row')
            .nth(this.fabricRow)
            .locator('.add-properties-btn')
            .click();
        await expect(this.priceMarginRow(priceMarginId)).toBeVisible();
    }

    /** Same id scheme as the page: "PM" + price margin id + fabric row. */
    priceMarginRow(priceMarginId: number): Locator {
        return this.page.locator(`tr#PM${priceMarginId}${this.fabricRow}`);
    }

    sizeInputs(priceMarginId: number): Locator {
        return this.priceMarginRow(priceMarginId).locator('input.size-grp');
    }

    async setSizes(priceMarginId: number, values: string[]) {
        const inputs = this.sizeInputs(priceMarginId);
        for (let i = 0; i < values.length; i++) {
            await inputs.nth(i).fill(values[i]);
            await inputs.nth(i).dispatchEvent('change');
        }
    }

    /** Empties one size without firing "change" (the page's change handler would turn '' into '0.00'). */
    async clearSizeSilently(priceMarginId: number, index: number) {
        await this.sizeInputs(priceMarginId)
            .nth(index)
            .evaluate((input) => {
                (input as HTMLInputElement).value = '';
            });
    }

    async sizeValues(priceMarginId: number): Promise<string[]> {
        return this.sizeInputs(priceMarginId).evaluateAll((inputs) =>
            inputs.map((input) => (input as HTMLInputElement).value)
        );
    }

    formulaSelect(priceMarginId: number): Locator {
        return this.priceMarginRow(priceMarginId).locator('select#formula_input');
    }

    async listedFormulaIds(priceMarginId: number): Promise<number[]> {
        const values = await this.formulaSelect(priceMarginId)
            .locator('option')
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
        return values.filter((value) => /^\d+$/.test(value)).map(Number).sort((a, b) => a - b);
    }

    async option(priceMarginId: number, formulaId: number): Promise<{ formulaName: string | null; label: string }> {
        const option = this.formulaSelect(priceMarginId).locator(`option[value="${formulaId}"]`);
        return {
            formulaName: await option.getAttribute('data-formula-name'),
            label: ((await option.textContent()) || '').trim(),
        };
    }

    async selectFormula(priceMarginId: number, formulaId: number) {
        await this.formulaSelect(priceMarginId).selectOption(String(formulaId));
    }

    qcToggle(priceMarginId: number): Locator {
        return this.priceMarginRow(priceMarginId).locator('input.qc-required');
    }

    /**
     * The QC switch's checkbox has no size on the page (custom switch drawn by CSS), so Playwright can't click it,
     * even with force. Dispatch a click event instead: it toggles the checkbox and fires its onchange, like a user click.
     */
    async setQc(priceMarginId: number, on: boolean) {
        if ((await this.qcToggle(priceMarginId).isChecked()) !== on) {
            await this.qcToggle(priceMarginId).dispatchEvent('click');
        }
        await expect(this.qcToggle(priceMarginId)).toBeChecked({ checked: on });
    }

    async deleteRow(priceMarginId: number) {
        await this.priceMarginRow(priceMarginId).locator('.delete-row').click();
    }

    /**
     * Clicks the create button with the item name empty: the page builds #properties, then stops at the
     * required-field check. Returns the pricing entries of this fabric row as they would be saved.
     */
    async readPropertiesToBeSaved(): Promise<SavedPricingEntry[]> {
        await expect(this.page.locator('#item_name')).toHaveValue('');
        await this.page.locator('.create-price-item-btn').click();
        await expect(this.page.locator('#error_div')).toBeVisible();

        const raw = await this.page.locator('#properties').inputValue();
        const fabrics = JSON.parse(raw);
        return fabrics[this.fabricRow].fabric_price_margin_properties;
    }

    // ---------- Saving: only used by the end-to-end flow (tests/e2e), which really saves ----------

    /** Brand ids that have at least one spec sheet (the server requires a spec sheet). */
    async brandIdsWithSpecSheets(): Promise<string[]> {
        return this.page.evaluate(() => {
            const ids = new Set<string>();
            ((window as any).spec_sheets || []).forEach((sheet: any) => {
                try {
                    (JSON.parse(sheet.brand_id_new || '[]') as string[]).forEach((id) => ids.add(String(id)));
                } catch {
                    /* ignore */
                }
            });
            return [...ids];
        });
    }

    /**
     * Picks the first spec sheet of the selected brand that gives the Factory Cost row size columns
     * (the spec sheet sets the size group, the sizes and the sports; then a sport is selected).
     * Returns the number of sizes (0 when none works).
     */
    async selectSpecSheetWithSizes(): Promise<number> {
        const sheets = await this.page.locator('#spec_sheet option').evaluateAll((options) =>
            options.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== '')
        );
        for (const sheet of sheets) {
            await this.page.evaluate((value) => {
                const $ = (window as any).$;
                $('#spec_sheet').val(value).trigger('change');
                const sport = $('#sport option').first().val();
                if (sport) {
                    $('#sport').val([sport]).trigger('change');
                }
            }, sheet);
            const sizes = await this.sizeInputs(FACTORY_COST_ID).count();
            if (sizes > 0) {
                return sizes;
            }
        }
        return 0;
    }

    async setItemName(name: string) {
        await this.page.locator('#item_name').fill(name);
    }

    /** Clicks the create button for real (page opened with save: true) and waits for the redirect. */
    async saveForReal() {
        await this.page.locator('.create-price-item-btn').click();
        await this.page.waitForURL('**/admin/price_items');
    }

    lastToast(): Locator {
        return this.page.locator('#toast-container .toast-message').last();
    }

    expectNoPageErrors() {
        expect(this.pageErrors.map((error) => error.message), 'JavaScript errors on the page').toEqual([]);
        expect(this.saveAttempts, 'requests to save the price item').toEqual([]);
    }
}
