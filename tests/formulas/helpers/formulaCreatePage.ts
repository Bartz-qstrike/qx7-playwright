import { expect, Locator, Page } from '@playwright/test';

export interface PostedFormula {
    formula: string;
    rows: Record<string, unknown>[];
}

/**
 * Page helpers for the formula line builder, shared by the create page (/admin/formula/add) and the edit page
 * (/admin/formula/edit/{id}, see FormulaEditPage).
 *
 * Never saves: the form's submit is cancelled in the page (the posted `formula` and `formula_price_margins` values
 * are captured instead), and any request to the store/update URL is aborted and recorded in `saveAttempts`.
 */
export class FormulaCreatePage {
    readonly pageErrors: Error[] = [];
    readonly saveAttempts: string[] = [];

    constructor(readonly page: Page) {
        page.on('pageerror', (error) => this.pageErrors.push(error));
    }

    async goto() {
        await this.open('/admin/formula/add', '**/admin/formula/store');
    }

    /** Opens the create page WITHOUT blocking the save: only for the end-to-end flow, which really saves. */
    async gotoForSave() {
        await this.page.goto('/admin/formula/add');
        await expect(this.page.locator('#add_price_margin_line')).toBeVisible();
    }

    async setName(name: string) {
        await this.page.locator('#name').fill(name);
    }

    /** Brands is a select2 multi-select: set it through jQuery like the page's own code. */
    async selectBrands(ids: (string | number)[]) {
        await this.page.evaluate((values) => {
            (window as any).$('#brand_ids').val(values).trigger('change');
        }, ids.map(String));
    }

    /** Clicks SAVE for real (page opened with gotoForSave) and waits for the redirect to the formulas list. */
    async saveForReal() {
        await this.page.locator('#create-formula').click();
        await this.page.waitForURL('**/admin/formulas');
    }

    /** Opens a builder page with its save URL blocked and the form's submit captured into `window.__posted`. */
    protected async open(path: string, saveUrl: string) {
        await this.page.route(saveUrl, async (route) => {
            this.saveAttempts.push(route.request().url());
            await route.abort();
        });
        await this.page.goto(path);
        await expect(this.page.locator('#add_price_margin_line')).toBeVisible();
        // Capture what SAVE would post and cancel the real submit (jQuery's .submit() honours preventDefault)
        await this.page.evaluate(() => {
            const $ = (window as any).$;
            $('#create_formula').on('submit', (event: any) => {
                (window as any).__posted = {
                    formula: $('#formula').val(),
                    rows: JSON.parse($('#formula_price_margins').val() || '[]'),
                };
                event.preventDefault();
            });
        });
    }

    lines(): Locator {
        return this.page.locator('#formula_lines .formula-line');
    }

    line(index: number): Locator {
        return this.lines().nth(index);
    }

    async addPriceMargin(name: string) {
        await this.page.locator('#add_price_margin_line').click();
        await this.lines().last().locator('select.line-value').selectOption({ label: name });
    }

    async addNumber(value: string) {
        await this.page.locator('#add_number_line').click();
        await this.lines().last().locator('input.line-value').fill(value);
    }

    async setOperation(index: number, op: string) {
        await this.line(index).locator('select.line-op').selectOption(op);
    }

    async toggleOpen(index: number) {
        await this.line(index).locator('.line-open').click();
    }

    async toggleClose(index: number) {
        await this.line(index).locator('.line-close').click();
    }

    async remove(index: number) {
        await this.line(index).locator('.line-remove').click();
    }

    preview(): Locator {
        return this.page.locator('#formula_preview');
    }

    /** Clicks SAVE; returns what would be posted, or null when the page stopped it (validation). */
    async save(): Promise<PostedFormula | null> {
        await this.page.evaluate(() => {
            (window as any).__posted = null;
        });
        await this.page.locator('#create-formula').click();
        return this.page.evaluate(() => (window as any).__posted);
    }

    lastToast(): Locator {
        return this.page.locator('#toast-container .toast').last();
    }

    async priceMarginId(name: string): Promise<number> {
        const value = await this.page
            .locator('#formula_lines select.line-value')
            .first()
            .locator('option', { hasText: name })
            .first()
            .getAttribute('value');
        return Number(value);
    }

    expectNoPageErrors() {
        expect(this.pageErrors.map((error) => error.message), 'JavaScript errors on the page').toEqual([]);
        expect(this.saveAttempts, 'requests to save the formula').toEqual([]);
    }
}
