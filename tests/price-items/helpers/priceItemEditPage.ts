import { APIRequestContext, expect, Locator, Page } from '@playwright/test';
import { FACTORY_COST_ID, SavedPricingEntry } from './priceItemCreatePage';

/** One pivot row (master_price_item_fabric_margins) as the edit page receives it in window.price_item.fabric_margins. */
export interface FabricMargin {
    fabric_id: number | null;
    price_margin_id: number;
    formula_id: number | null;
    qc_required?: boolean | number;
    size_prices?: { price: string; size_code: string; size_id?: number }[] | null;
    fabric: { id: number; fabric_code: string } | null;
}

export interface SavedFabric {
    fabric_code?: string;
    fabric_name?: string;
    fabric_price_margin_properties: SavedPricingEntry[];
}

export interface PriceItem {
    id: number;
    type: string | null;
    brand_id: number;
    properties: string | null;
    fabric_margins?: FabricMargin[];
}

/** One price margin row with a formula dropdown, as saved in `properties`. */
export interface SavedRow {
    fabricIndex: number;
    fabricCode: string | undefined;
    priceMarginId: number;
    entry: SavedPricingEntry;
}

export function parseProperties(item: PriceItem): SavedFabric[] {
    try {
        const parsed = JSON.parse(item.properties || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** Saved rows that have a formula dropdown on the page (every price margin except Factory Cost). */
export function savedRows(item: PriceItem): SavedRow[] {
    const rows: SavedRow[] = [];
    parseProperties(item).forEach((fabric, fabricIndex) => {
        (fabric.fabric_price_margin_properties || []).forEach((entry) => {
            const priceMarginId = Number(entry.price_margin_properties?.price_margin_id);
            if (priceMarginId && priceMarginId !== FACTORY_COST_ID) {
                rows.push({ fabricIndex, fabricCode: fabric.fabric_code, priceMarginId, entry });
            }
        });
    });
    return rows;
}

/** Same rule as the page: match on fabric code; a row saved without a fabric code matches the pivot row with no fabric. */
export function pivotRow(item: PriceItem, fabricCode: string | undefined, priceMarginId: number): FabricMargin | undefined {
    return (item.fabric_margins || []).find(
        (m) =>
            (fabricCode ? m.fabric?.fabric_code === fabricCode : m.fabric_id == null) &&
            Number(m.price_margin_id) === priceMarginId
    );
}

export async function getPriceItem(request: APIRequestContext, id: number): Promise<PriceItem> {
    const response = await request.get(`/api/price_item/${id}`);
    expect(response.ok(), `GET /api/price_item/${id}`).toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);
    return body.master_price_item;
}

/**
 * Walks the newest price items (25 per page) and returns the first one of the wanted kind (legacy or not) that
 * `accept` returns true for. Only reads: GET /api/price_items_paginate and GET /api/price_item/{id}.
 */
export async function findPriceItem(
    request: APIRequestContext,
    accept: (item: PriceItem) => boolean,
    legacy = false,
    maxPages = 8
): Promise<PriceItem | null> {
    for (let page = 1; page <= maxPages; page++) {
        const response = await request.get(`/api/price_items_paginate?page=${page}`);
        expect(response.ok(), 'GET /api/price_items_paginate').toBeTruthy();
        const list: PriceItem[] = (await response.json()).data || [];
        for (const summary of list) {
            // Skip the records saved by tests/e2e (multi price margin formulas the old string-split logic can't check)
            const name = String((summary as any).item_name || '');
            if ((summary.type === 'Legacy') !== legacy || savedRows(summary).length === 0 || name.startsWith('Playwright E2E')) {
                continue;
            }
            const item = await getPriceItem(request, summary.id);
            if (accept(item)) {
                return item;
            }
        }
        if (list.length === 0) {
            break;
        }
    }
    return null;
}

/** The two edit pages share one URL; the controller picks the view by the price item's type. */
export interface EditPage {
    name: string;
    legacy: boolean;
}

export const PRICE_ITEM_EDIT_PAGE: EditPage = { name: 'Price item edit page', legacy: false };
export const LEGACY_PRICE_ITEM_EDIT_PAGE: EditPage = { name: 'Legacy price item edit page', legacy: true };

/**
 * Page helpers for /admin/price_item/edit/{id} (price item edit page, or the legacy one for a Legacy item).
 *
 * Never saves: requests to the update URLs are aborted and recorded (see `saveAttempts`), and
 * `readPropertiesToBeSaved()` empties the item name first so the page stops at its required-field check
 * after building `properties`.
 */
export class PriceItemEditPage {
    readonly pageErrors: Error[] = [];
    readonly saveAttempts: string[] = [];

    constructor(readonly page: Page) {
        page.on('pageerror', (error) => this.pageErrors.push(error));
    }

    /**
     * Changes the pivot formula_id the page receives for one fabric + price margin, before the page reads it
     * (window.price_item is set by the page's inline script; the setter edits it on the way in).
     */
    async overridePivotFormula(fabricCode: string | undefined, priceMarginId: number, formulaId: number | null) {
        await this.page.addInitScript(
            ({ fabricCode, priceMarginId, formulaId }) => {
                let stored: any;
                Object.defineProperty(window, 'price_item', {
                    configurable: true,
                    get: () => stored,
                    set: (value: any) => {
                        (value?.fabric_margins || []).forEach((row: any) => {
                            // Same rule as the page: an empty/missing fabric code matches the pivot row with no fabric
                            const sameFabric = fabricCode ? row.fabric?.fabric_code === fabricCode : row.fabric_id == null;
                            if (sameFabric && Number(row.price_margin_id) === priceMarginId) {
                                row.formula_id = formulaId;
                            }
                        });
                        stored = value;
                    },
                });
            },
            { fabricCode, priceMarginId, formulaId }
        );
    }

    /** `save: true` leaves the update URLs open: only for the end-to-end flow (tests/e2e), which really saves. */
    async goto(id: number, options: { save?: boolean } = {}) {
        for (const pattern of options.save ? [] : ['**/admin/price_item/update**', '**/api/price_item/update**']) {
            await this.page.route(pattern, async (route) => {
                this.saveAttempts.push(route.request().url());
                await route.abort();
            });
        }
        await this.page.goto(`/admin/price_item/edit/${id}`);
        await expect(this.page.locator('select#formula_input').first()).toBeAttached();
    }

    fabricRow(fabricIndex: number): Locator {
        return this.page.locator('.price-margin-fabric-property-row').nth(fabricIndex);
    }

    priceMarginRow(fabricIndex: number, priceMarginId: number): Locator {
        return this.fabricRow(fabricIndex)
            .locator('.properties-table tbody tr')
            .filter({ has: this.page.locator(`input.price-margin-info[data-price-margin="${priceMarginId}"]`) });
    }

    sizeInputs(fabricIndex: number, priceMarginId: number): Locator {
        return this.priceMarginRow(fabricIndex, priceMarginId).locator('input.size-grp');
    }

    async sizeValues(fabricIndex: number, priceMarginId: number): Promise<string[]> {
        return this.sizeInputs(fabricIndex, priceMarginId).evaluateAll((inputs) =>
            inputs.map((input) => (input as HTMLInputElement).value)
        );
    }

    formulaSelect(fabricIndex: number, priceMarginId: number): Locator {
        return this.priceMarginRow(fabricIndex, priceMarginId).locator('select#formula_input');
    }

    /** Options of a row's dropdown: id (value), formula text (data-formula-name), whether marked selected in the HTML. */
    async options(fabricIndex: number, priceMarginId: number) {
        return this.formulaSelect(fabricIndex, priceMarginId)
            .locator('option')
            .evaluateAll((options) =>
                options.map((o) => ({
                    id: Number((o as HTMLOptionElement).value),
                    value: (o as HTMLOptionElement).value,
                    formulaName: o.getAttribute('data-formula-name'),
                    preselected: o.hasAttribute('selected'),
                }))
            );
    }

    /** The option marked `selected` when the row was drawn (null when none is, the browser then shows the first). */
    async preselectedFormulaId(fabricIndex: number, priceMarginId: number): Promise<number | null> {
        const option = (await this.options(fabricIndex, priceMarginId)).find((o) => o.preselected);
        return option ? option.id : null;
    }

    async selectedFormula(fabricIndex: number, priceMarginId: number) {
        const select = this.formulaSelect(fabricIndex, priceMarginId);
        return {
            id: Number(await select.inputValue()),
            formulaName: await select.locator('option:checked').getAttribute('data-formula-name'),
        };
    }

    async selectFormula(fabricIndex: number, priceMarginId: number, formulaId: number) {
        await this.formulaSelect(fabricIndex, priceMarginId).selectOption(String(formulaId));
    }

    qcToggle(fabricIndex: number, priceMarginId: number): Locator {
        return this.priceMarginRow(fabricIndex, priceMarginId).locator('input.qc-required');
    }

    /** Same as the create page: the custom switch has no size, so dispatch the click (toggles + fires onchange). */
    async setQc(fabricIndex: number, priceMarginId: number, on: boolean) {
        const toggle = this.qcToggle(fabricIndex, priceMarginId);
        if ((await toggle.isChecked()) !== on) {
            await toggle.dispatchEvent('click');
        }
        await expect(toggle).toBeChecked({ checked: on });
    }

    async priceItem(): Promise<PriceItem> {
        return this.page.evaluate(() => (window as any).price_item);
    }

    /**
     * Empties the item name and clicks SAVE: the page builds #properties, then stops at the required-field check.
     * Returns every fabric as it would be saved.
     */
    async readPropertiesToBeSaved(): Promise<SavedFabric[]> {
        await this.page.locator('#item_name').fill('');
        await this.page.locator('.create-price-item-btn').click();
        await expect(this.page.locator('#error_div')).toBeVisible();
        return JSON.parse(await this.page.locator('#properties').inputValue());
    }

    async setSizes(fabricIndex: number, priceMarginId: number, values: string[]) {
        const inputs = this.sizeInputs(fabricIndex, priceMarginId);
        for (let i = 0; i < values.length; i++) {
            await inputs.nth(i).fill(values[i]);
            await inputs.nth(i).dispatchEvent('change');
        }
    }

    /** Clicks SAVE for real (page opened with save: true) and waits for the redirect to the price items list. */
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
