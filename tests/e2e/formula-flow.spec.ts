import { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { FormulaCreatePage } from '../formulas/helpers/formulaCreatePage';
import { FormulaEditPage, linesFromRows } from '../formulas/helpers/formulaEditPage';
import { AddOnsPage } from '../add-ons/helpers/addOnsPage';
import {
    CreatePage,
    FACTORY_COST_ID,
    LEGACY_PRICE_ITEM_CREATE_PAGE,
    PRICE_ITEM_CREATE_PAGE,
    PriceItemCreatePage,
} from '../price-items/helpers/priceItemCreatePage';
import { PriceItem, PriceItemEditPage, getPriceItem, parseProperties } from '../price-items/helpers/priceItemEditPage';
import { BulkUpdatePage } from '../price-items/helpers/bulkUpdatePage';
import { Formula, getFormulas, roundLikePage } from '../helpers/formulas';

/**
 * End-to-end flow. Unlike every other spec, this one REALLY SAVES and leaves the records in the local DB so they can
 * be checked by hand afterwards. Every record is named "Playwright E2E <stamp>":
 *   1. a formula, built on the formula create page:  Brand Cost (BC) * ( MSRP + 2 ) / <divisor>
 *   2. a fixed-amount add-on using it (create page), 3-4. a price item and a legacy price item using it (create pages)
 *   5-7. the same add-on and price items opened on their edit pages, values changed, recomputed and saved again
 *   8. bulk update (/admin/price_items/bulk_update) of Brand Cost +10% on both price items: the formula row is
 *      recomputed on the server from the formula's formula_price_margins rows (MSRP from the pivot table).
 * Factory Cost is not part of the formula (the pages still require it, so it gets a plain value).
 * The divisor changes per run so the formula text is unique (the price item edit page may match a formula by text).
 */

const BC = 16;
const BC_NAME = 'Brand Cost (BC)';
const MSRP = 7;
const MSRP_NAME = 'MSRP';

const now = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const STAMP = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(
    now.getMinutes()
)}:${pad(now.getSeconds())}`;
const NAME = `Playwright E2E ${STAMP}`;
const DIVISOR = 2 + (now.getSeconds() + now.getMinutes() * 7) % 60;

const compute = (bc: number, msrp: number) => roundLikePage((bc * (msrp + 2)) / DIVISOR);

/** State shared by the serial tests. */
const flow: {
    brandId?: string;
    formula?: Formula;
    addOnId?: number;
    addOnTarget?: number;
    priceItems: Record<string, { id: number; target: number }>;
} = { priceItems: {} };

test.describe.configure({ mode: 'serial' });

// ---------- helpers ----------

async function findAddOnByName(request: APIRequestContext, name: string) {
    const response = await request.get('/api/master_add_ons');
    expect(response.ok()).toBeTruthy();
    const addOns: any[] = (await response.json()).add_ons;
    return addOns.find((a) => a.add_on_name === name);
}

async function findPriceItemByName(request: APIRequestContext, name: string): Promise<PriceItem | undefined> {
    for (let page = 1; page <= 3; page++) {
        const response = await request.get(`/api/price_items_paginate?page=${page}`);
        expect(response.ok()).toBeTruthy();
        const list: any[] = (await response.json()).data || [];
        const found = list.find((item) => item.item_name === name);
        if (found) {
            return getPriceItem(request, found.id);
        }
    }
    return undefined;
}

/** size values of one price margin in the first fabric of a saved price item, in size order. */
function savedSizes(item: PriceItem, priceMarginId: number) {
    const entry = parseProperties(item)[0].fabric_price_margin_properties.find(
        (e) => Number(e.price_margin_properties.price_margin_id) === priceMarginId
    );
    expect(entry, `price margin ${priceMarginId} saved`).toBeTruthy();
    return { entry: entry!, sizes: entry!.sizes.map((s) => Object.values(s)[0]) };
}

function sizeValues(count: number, from: number, step: number) {
    return Array.from({ length: count }, (_, i) => (from + i * step).toFixed(2));
}

/** First selectable price margin that is not Factory Cost, Brand Cost or MSRP: the row that gets the formula. */
function pickTarget(selectable: number[]) {
    const target = selectable.find((id) => id && ![FACTORY_COST_ID, BC, MSRP].includes(id));
    expect(target, 'a price margin other than FC, BC and MSRP to put the formula on').toBeTruthy();
    return target!;
}

/** Opens a price item create page ready to save: brand, spec sheet with sizes, sport. Returns the size count. */
async function prepareCreatePage(cp: PriceItemCreatePage, brandId: string) {
    await cp.goto({ save: true });
    await cp.selectBrand(brandId);
    const sizes = await cp.selectSpecSheetWithSizes();
    expect(sizes, 'a spec sheet of the brand gives sizes').toBeGreaterThan(0);
    return sizes;
}

/** Brand usable everywhere: on both price item create pages (with a spec sheet giving sizes) and on the add-ons page. */
async function pickBrand(page: Page): Promise<string> {
    const addOns = new AddOnsPage(page);
    await addOns.gotoCreate();
    const addOnBrands = new Set(await addOns.brandIds());

    const cp = new PriceItemCreatePage(page, PRICE_ITEM_CREATE_PAGE.path);
    await cp.goto();
    const candidates = (await cp.brandIdsWithSpecSheets()).filter((id) => addOnBrands.has(id));
    for (const brandId of candidates) {
        await cp.goto();
        await cp.selectBrand(brandId);
        if ((await cp.selectSpecSheetWithSizes()) > 0) {
            return brandId;
        }
    }
    throw new Error('No brand has a spec sheet with sizes and is also offered on the add-ons page');
}

// ---------- tests ----------

// The title must not contain the stamp: Playwright matches tests between the listing and the worker by title.
test.describe('Formula end-to-end flow (saves "Playwright E2E <stamp>" records)', () => {
    test.beforeAll(() => {
        console.log(`Records of this run: "${NAME}", formula divisor ${DIVISOR}`);
    });

    test('1. create the formula on the formula create page', async ({ page, request }) => {
        flow.brandId = await pickBrand(page);

        const fp = new FormulaCreatePage(page);
        await fp.gotoForSave();
        await fp.setName(NAME);
        await fp.selectBrands([flow.brandId]);

        await fp.addPriceMargin(BC_NAME);
        await fp.addPriceMargin(MSRP_NAME);
        await fp.setOperation(1, '*');
        await fp.toggleOpen(1);
        await fp.addNumber('2');
        await fp.setOperation(2, '+');
        await fp.toggleClose(2);
        await fp.addNumber(String(DIVISOR));
        await fp.setOperation(3, '/');
        await expect(fp.preview()).toHaveText(`${BC_NAME} * ( ${MSRP_NAME} + 2 ) / ${DIVISOR}`);

        await fp.saveForReal();
        expect(fp.pageErrors.map((e) => e.message)).toEqual([]);

        const formula = (await getFormulas(request, flow.brandId)).find((f) => f.name === NAME);
        expect(formula, 'the saved formula is returned for its brand').toBeTruthy();
        flow.formula = formula!;

        expect(formula!.formula).toBe(`${BC_NAME} | * | ( | ${MSRP_NAME} | + | 2 | ) | / | ${DIVISOR}`);
        const rows = [...formula!.formula_price_margins].sort((a, b) => a.index_in_formula - b.index_in_formula);
        expect(
            rows.map((r) => ({
                price_margin_id: r.price_margin_id,
                operator: r.operator,
                parentheses: r.parentheses ?? null,
                variable: r.variable == null ? null : Number(r.variable),
            }))
        ).toEqual([
            { price_margin_id: BC, operator: null, parentheses: null, variable: null },
            { price_margin_id: null, operator: '*', parentheses: null, variable: null },
            { price_margin_id: null, operator: null, parentheses: '(', variable: null },
            { price_margin_id: MSRP, operator: null, parentheses: null, variable: null },
            { price_margin_id: null, operator: '+', parentheses: null, variable: null },
            { price_margin_id: null, operator: null, parentheses: null, variable: 2 },
            { price_margin_id: null, operator: null, parentheses: ')', variable: null },
            { price_margin_id: null, operator: '/', parentheses: null, variable: null },
            { price_margin_id: null, operator: null, parentheses: null, variable: DIVISOR },
        ]);

        // The edit page (save blocked) shows the same lines, loaded from formula_price_margins
        const ep = new FormulaEditPage(page);
        await ep.gotoFormula(formula!.id);
        expect(await ep.shownLines()).toEqual(linesFromRows(formula!.formula_price_margins));
        ep.expectNoPageErrors();
    });

    test('2. create an add-on with the formula', async ({ page, request }) => {
        const addOns = new AddOnsPage(page);
        await addOns.gotoCreate();
        await addOns.selectBrand(flow.brandId!);
        await addOns.setNameAndDescription(NAME, 'Created by the Playwright end-to-end formula flow');
        await page.evaluate(() => {
            const $ = (window as any).$;
            if (!$('#factory_id').val()) {
                $('#factory_id').val($('#factory_id option').filter((_: number, o: any) => o.value).first().val());
            }
        });

        const target = pickTarget(await addOns.selectablePriceMarginIds());
        flow.addOnTarget = target;

        await addOns.setFactoryCost('10.00');
        await addOns.addPriceMargin(BC);
        await addOns.setValue(BC, '100.00');
        await addOns.addPriceMargin(MSRP);
        await addOns.setValue(MSRP, '20.00');
        await addOns.addPriceMargin(target);

        expect(await addOns.listedFormulaIds(target)).toContain(flow.formula!.id);
        expect(await addOns.optionLabel(target, flow.formula!.id)).toBe(`${BC_NAME} * ( ${MSRP_NAME} + 2 ) / ${DIVISOR}`);

        await addOns.selectFormula(target, flow.formula!.id);
        await addOns.setToggle(target, true);
        const expected = compute(100, 20);
        await expect(addOns.valueInput(target)).toHaveValue(expected);

        await addOns.saveForReal();
        addOns.expectNoPageErrors();

        const saved = await findAddOnByName(request, NAME);
        expect(saved, 'the add-on is saved').toBeTruthy();
        flow.addOnId = saved.id;
        const detail = JSON.parse(saved.pricing_details).find((d: any) => Number(d.price_margin_id) === target);
        expect(Number(detail.formula_id)).toBe(flow.formula!.id);
        expect(Number(detail.price).toFixed(2)).toBe(expected);
        expect(Number(detail.is_active)).toBe(1);
    });

    for (const createPage of [PRICE_ITEM_CREATE_PAGE, LEGACY_PRICE_ITEM_CREATE_PAGE] as CreatePage[]) {
        const index = createPage === PRICE_ITEM_CREATE_PAGE ? 3 : 4;
        test(`${index}. create a price item with the formula (${createPage.name})`, async ({ page, request }) => {
            const cp = new PriceItemCreatePage(page, createPage.path);
            const count = await prepareCreatePage(cp, flow.brandId!);
            const itemName = `${NAME} ${createPage === PRICE_ITEM_CREATE_PAGE ? 'price item' : 'legacy price item'}`;
            await cp.setItemName(itemName);

            const target = pickTarget(await cp.selectablePriceMarginIds());
            const bc = sizeValues(count, 100, 10);
            const msrp = sizeValues(count, 20, 1);

            await cp.setSizes(FACTORY_COST_ID, sizeValues(count, 10, 1));
            await cp.addPriceMargin(BC);
            await cp.setSizes(BC, bc);
            await cp.addPriceMargin(MSRP);
            await cp.setSizes(MSRP, msrp);
            await cp.addPriceMargin(target);

            expect(await cp.listedFormulaIds(target)).toContain(flow.formula!.id);
            await cp.selectFormula(target, flow.formula!.id);
            await cp.setQc(target, true);

            const expected = bc.map((value, i) => compute(Number(value), Number(msrp[i])));
            expect(await cp.sizeValues(target)).toEqual(expected);

            await cp.saveForReal();
            expect(cp.pageErrors.map((e) => e.message)).toEqual([]);

            const saved = await findPriceItemByName(request, itemName);
            expect(saved, 'the price item is saved').toBeTruthy();
            flow.priceItems[createPage.path] = { id: saved!.id, target };

            const { entry, sizes } = savedSizes(saved!, target);
            expect(sizes.map((v) => Number(v).toFixed(2))).toEqual(expected);
            expect(Number(entry.qc_required)).toBe(1);
            expect(Number(entry.formula_id)).toBe(flow.formula!.id);
            expect(entry.formula).toBe(flow.formula!.formula);
        });
    }

    test('5. edit the add-on: the formula recomputes from the new values and saves', async ({ page, request }) => {
        test.skip(!flow.addOnId, 'The add-on was not created');
        const target = flow.addOnTarget!;
        const addOns = new AddOnsPage(page);
        await addOns.gotoEdit(flow.addOnId!);

        await expect(addOns.formulaSelect(target)).toHaveValue(String(flow.formula!.id));
        await expect(addOns.toggle(target)).toBeChecked();

        await addOns.setValue(BC, '40.00');
        await addOns.setValue(MSRP, '6.00');
        await addOns.setToggle(target, false);
        await addOns.setToggle(target, true);
        const expected = compute(40, 6);
        await expect(addOns.valueInput(target)).toHaveValue(expected);

        await addOns.saveForReal();
        addOns.expectNoPageErrors();

        const saved = await findAddOnByName(request, NAME);
        const detail = JSON.parse(saved.pricing_details).find((d: any) => Number(d.price_margin_id) === target);
        expect(Number(detail.formula_id)).toBe(flow.formula!.id);
        expect(Number(detail.price).toFixed(2)).toBe(expected);
    });

    for (const createPage of [PRICE_ITEM_CREATE_PAGE, LEGACY_PRICE_ITEM_CREATE_PAGE] as CreatePage[]) {
        const index = createPage === PRICE_ITEM_CREATE_PAGE ? 6 : 7;
        const label = createPage === PRICE_ITEM_CREATE_PAGE ? 'price item edit page' : 'legacy price item edit page';
        test(`${index}. edit the price item on the ${label}: recomputes and saves`, async ({ page, request }) => {
            const created = flow.priceItems[createPage.path];
            test.skip(!created, 'The price item was not created');
            const ep = new PriceItemEditPage(page);
            await ep.goto(created.id, { save: true });

            const target = created.target;
            await expect(ep.formulaSelect(0, target)).toHaveValue(String(flow.formula!.id));
            await expect(ep.qcToggle(0, target)).toBeChecked();

            const count = await ep.sizeInputs(0, BC).count();
            const bc = sizeValues(count, 50, 5);
            const msrp = sizeValues(count, 8, 2);
            await ep.setSizes(0, BC, bc);
            await ep.setSizes(0, MSRP, msrp);
            await ep.setQc(0, target, false);
            await ep.setQc(0, target, true);

            const expected = bc.map((value, i) => compute(Number(value), Number(msrp[i])));
            expect(await ep.sizeValues(0, target)).toEqual(expected);

            await ep.saveForReal();
            expect(ep.pageErrors.map((e) => e.message)).toEqual([]);

            const saved = await getPriceItem(request, created.id);
            const { entry, sizes } = savedSizes(saved, target);
            expect(sizes.map((v) => Number(v).toFixed(2))).toEqual(expected);
            expect(Number(entry.formula_id)).toBe(flow.formula!.id);
            expect(savedSizes(saved, BC).sizes.map((v) => Number(v).toFixed(2))).toEqual(bc);
        });
    }

    test('8. bulk update Brand Cost: the formula rows are recomputed from formula_price_margins', async ({
        page,
        request,
    }) => {
        const items = Object.values(flow.priceItems);
        test.skip(items.length === 0, 'No price item was created');

        // The bulk update only adjusts a price margin whose own row has QC on (and turns it off afterwards).
        // So first turn Brand Cost's QC on, with the first formula its row offers (based on Factory Cost) that gives
        // non-zero prices (e.g. "Factory Cost (FC) | * | 0" would make every check trivially 0), and save.
        for (const created of items) {
            const ep = new PriceItemEditPage(page);
            await ep.goto(created.id, { save: true });
            await ep.setQc(0, BC, true);
            let picked = false;
            for (const option of (await ep.options(0, BC)).filter((o) => o.id)) {
                await ep.selectFormula(0, BC, option.id);
                const values = await ep.sizeValues(0, BC);
                if (values.length && values.every((v) => Number(v) > 0)) {
                    picked = true;
                    break;
                }
            }
            expect(picked, 'the Brand Cost row offers a formula giving non-zero prices').toBe(true);
            await ep.saveForReal();
            expect(ep.pageErrors.map((e) => e.message)).toEqual([]);
        }

        // The bulk update reads MSRP from the pivot table (synced by the queue after each save): wait until it matches
        const before: Record<number, { bc: Record<string, string>; msrp: Record<string, string> }> = {};
        for (const created of items) {
            await expect
                .poll(
                    async () => {
                        const item = await getPriceItem(request, created.id);
                        const margins = (item.fabric_margins || []).filter((m) => m.fabric_id == null);
                        const bcPivot = margins.find((m) => Number(m.price_margin_id) === BC);
                        const msrpPivot = margins.find((m) => Number(m.price_margin_id) === MSRP);
                        const targetPivot = margins.find((m) => Number(m.price_margin_id) === created.target);
                        const msrpSaved = savedSizes(item, MSRP).sizes.map((v) => Number(v).toFixed(2));
                        const msrpPivotPrices = (msrpPivot?.size_prices || []).map((s) => Number(s.price).toFixed(2));
                        return (
                            !!bcPivot?.qc_required &&
                            Number(targetPivot?.formula_id) === flow.formula!.id &&
                            JSON.stringify(msrpPivotPrices) === JSON.stringify(msrpSaved)
                        );
                    },
                    { message: `pivot rows of price item ${created.id} synced (is the queue worker running?)`, timeout: 30_000 }
                )
                .toBe(true);

            const item = await getPriceItem(request, created.id);
            const sizeMap = (priceMarginId: number) =>
                Object.assign({}, ...savedSizes(item, priceMarginId).entry.sizes) as Record<string, string>;
            before[created.id] = { bc: sizeMap(BC), msrp: sizeMap(MSRP) };
            expect(Object.values(before[created.id].bc).every((v) => Number(v) > 0), 'Brand Cost prices before').toBe(true);
        }

        // Bulk update: Brand Cost +10% on both price items
        const bulk = new BulkUpdatePage(page);
        await bulk.goto();
        await bulk.search(flow.brandId!, BC);
        for (const created of items) {
            await expect(bulk.dependentCheckbox(created.id), `price item ${created.id} listed as formula dependent`).toBeVisible();
        }
        const response = await bulk.adjustDependent(
            items.map((i) => i.id),
            '10',
            'percentage'
        );
        expect(response.errors).toEqual([]);
        bulk.expectNoPageErrors();

        for (const created of items) {
            const item = await getPriceItem(request, created.id);
            const { bc, msrp } = before[created.id];

            // Brand Cost: +10% (PHP number_format), QC turned off by the bulk update
            const bcAfter = savedSizes(item, BC);
            const expectedBc = Object.fromEntries(
                Object.entries(bc).map(([size, value]) => [size, phpRound(Number(value) * 1.1)])
            );
            expect(Object.assign({}, ...bcAfter.entry.sizes)).toEqual(expectedBc);
            expect(Number(bcAfter.entry.qc_required)).toBe(0);

            // The formula row: new Brand Cost * ( MSRP from the pivot + 2 ) / divisor, per size
            const targetAfter = savedSizes(item, created.target);
            const expectedTarget = Object.fromEntries(
                Object.keys(bc).map((size) => [
                    size,
                    phpRound((Number(expectedBc[size]) * (Number(msrp[size]) + 2)) / DIVISOR),
                ])
            );
            expect(Object.assign({}, ...targetAfter.entry.sizes)).toEqual(expectedTarget);
            expect(Number(targetAfter.entry.qc_required)).toBe(1);
            expect(Number(targetAfter.entry.formula_id)).toBe(flow.formula!.id);
        }
    });
});

/** Same as PHP's number_format($value, 2) without thousands separators (half up). */
function phpRound(value: number): string {
    return (Math.round(Number(value.toFixed(8)) * 100) / 100).toFixed(2);
}
