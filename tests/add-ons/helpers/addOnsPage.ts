import { expect, Locator, Page } from '@playwright/test';

/**
 * Page helpers for the add-ons create/edit pages (Fixed Amount section).
 * Never clicks Save/Submit: tests only read and interact.
 */
export class AddOnsPage {
    readonly pageErrors: Error[] = [];

    constructor(readonly page: Page) {
        page.on('pageerror', (error) => this.pageErrors.push(error));
    }

    async gotoCreate() {
        await this.page.goto('/admin/master_add_on/add');
        await expect(this.page.locator('#add_price_margin')).toBeVisible();
    }

    async gotoEdit(addOnId: number | string) {
        await this.page.goto(`/admin/master_add_on/edit/${addOnId}`);
        await expect(this.page.locator('#price_margin_table')).toBeAttached();
    }

    async brandIds(): Promise<string[]> {
        return this.page.locator('#brand_id option').evaluateAll((options) =>
            options.map((option) => (option as HTMLOptionElement).value)
        );
    }

    /** Price margins offered in the "VALUE" dropdown (Factory Cost is not in it). */
    async selectablePriceMarginIds(): Promise<number[]> {
        return this.page.locator('#price_margin option').evaluateAll((options) =>
            options.map((option) => Number((option as HTMLOptionElement).value))
        );
    }

    async selectBrand(brandId: string | number) {
        await this.page.locator('#brand_id').selectOption(String(brandId));
        // selectOption does not fire "change" when the value is already selected
        await this.page.locator('#brand_id').dispatchEvent('change');
    }

    async setFactoryCost(value: string) {
        await this.page.locator('#fixed_amount_fc_val').fill(value);
        await this.page.locator('#fixed_amount_fc_val').dispatchEvent('change');
    }

    async addPriceMargin(priceMarginId: number) {
        await this.page.locator('#price_margin').selectOption(String(priceMarginId));
        await this.page.locator('#add_price_margin').click();
        await expect(this.row(priceMarginId)).toBeVisible();
    }

    row(priceMarginId: number): Locator {
        return this.page.locator(`#fixed_amount_${priceMarginId}`);
    }

    formulaSelect(priceMarginId: number): Locator {
        return this.page.locator(`#formula_${priceMarginId}`);
    }

    /** Formula ids listed in a price margin's dropdown (ignores the "No Formula Found" placeholder). */
    async listedFormulaIds(priceMarginId: number): Promise<number[]> {
        const values = await this.formulaSelect(priceMarginId)
            .locator('option')
            .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
        return values.filter((value) => /^\d+$/.test(value)).map(Number).sort((a, b) => a - b);
    }

    async optionLabel(priceMarginId: number, formulaId: number): Promise<string> {
        const text = await this.formulaSelect(priceMarginId).locator(`option[value="${formulaId}"]`).textContent();
        return (text || '').trim();
    }

    async selectFormula(priceMarginId: number, formulaId: number) {
        await this.formulaSelect(priceMarginId).selectOption(String(formulaId));
    }

    toggle(priceMarginId: number): Locator {
        return this.page.locator(`#toggle_${priceMarginId}`);
    }

    /**
     * Clicks the switch once. The checkbox is visually hidden and its <label> is empty (the switch is drawn by CSS),
     * so Playwright sees neither as visible; force-click the checkbox, which fires the same "change" event.
     */
    async clickToggle(priceMarginId: number) {
        await this.toggle(priceMarginId).click({ force: true });
    }

    async setToggle(priceMarginId: number, on: boolean) {
        if ((await this.toggle(priceMarginId).isChecked()) !== on) {
            await this.clickToggle(priceMarginId);
        }
        await expect(this.toggle(priceMarginId)).toBeChecked({ checked: on });
    }

    valueInput(priceMarginId: number): Locator {
        return this.page.locator(`#fixed_value_${priceMarginId}`);
    }

    async setValue(priceMarginId: number, value: string) {
        await this.valueInput(priceMarginId).fill(value);
        await this.valueInput(priceMarginId).dispatchEvent('change');
    }

    /** Empties a value without firing "change" (the page's change handler would turn '' into '0.00'). */
    async clearValueSilently(priceMarginId: number) {
        await this.valueInput(priceMarginId).evaluate((input) => {
            (input as HTMLInputElement).value = '';
        });
    }

    async factoryCostValue(): Promise<string> {
        return this.page.locator('#fixed_amount_fc_val').inputValue();
    }

    // ---------- Saving: only used by the end-to-end flow (tests/e2e), which really saves ----------

    async setNameAndDescription(name: string, description: string) {
        await this.page.locator('#add_on_name').fill(name);
        await this.page.locator('#description').fill(description);
    }

    /** Clicks the page's save button (create or update) and waits for the redirect to the add-ons list. */
    async saveForReal() {
        await this.page.locator('#submit').click();
        await this.page.waitForURL('**/admin/master_add_ons');
    }

    lastToast(): Locator {
        return this.page.locator('#toast-container .toast-message').last();
    }

    expectNoPageErrors() {
        expect(this.pageErrors.map((error) => error.message), 'JavaScript errors on the page').toEqual([]);
    }
}
