import { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { Formula, getPriceMargins, legacyCompute, legacyPriceMarginName, PriceMargin, roundLikePage } from '../../helpers/formulas';
import {
    EditPage,
    findPriceItem,
    parseProperties,
    pivotRow,
    PriceItem,
    PriceItemEditPage,
    SavedRow,
    savedRows,
} from './priceItemEditPage';

/**
 * Shared tests for the price item edit pages (/admin/price_item/edit/{id}; the controller shows the legacy page for
 * Legacy items). Both pages have the same formula code:
 *   - the formula a saved row starts with comes from the pivot table master_price_item_fabric_margins (formula_id),
 *     falling back to the saved `formula` text when the pivot has none;
 *   - prices are computed from formula_price_margins (expected values use the OLD string-split logic);
 *   - size prices shown are still the saved `properties` values.
 * Each page has its own spec file that calls defineEditPageTests() with its page.
 *
 * Price items of the page's kind are found in the local data (newest first). Nothing is saved: the update URLs are
 * blocked and the item name is emptied before SAVE is clicked.
 */

interface Scenarios {
    priceMargins: PriceMargin[];
    /** Has pivot rows with a formula_id. */
    withPivot: PriceItem | null;
    /** Has no pivot rows but has saved formulas. */
    withoutPivot: PriceItem | null;
    /** Has a QC-on row with a formula. */
    withQc: PriceItem | null;
}

/** Found once per page (legacy or not) and reused by its later tests. */
const scenarios = new Map<boolean, Scenarios>();

async function getScenarios(request: APIRequestContext, legacy: boolean): Promise<Scenarios> {
    if (!scenarios.has(legacy)) {
        const hasPivotFormula = (item: PriceItem) =>
            savedRows(item).some((row) => pivotRow(item, row.fabricCode, row.priceMarginId)?.formula_id != null);
        const withPivot = await findPriceItem(request, hasPivotFormula, legacy);
        const withoutPivot = await findPriceItem(
            request,
            (item) => (item.fabric_margins || []).length === 0 && savedRows(item).some((row) => !!row.entry.formula),
            legacy
        );
        const hasQc = (item: PriceItem) => savedRows(item).some((row) => !!row.entry.qc_required && !!row.entry.formula);
        const withQc = withPivot && hasQc(withPivot) ? withPivot : await findPriceItem(request, hasQc, legacy);
        scenarios.set(legacy, { priceMargins: await getPriceMargins(request), withPivot, withoutPivot, withQc });
    }
    return scenarios.get(legacy)!;
}

export function defineEditPageTests(editPage: EditPage) {
    const kind = editPage.legacy ? 'legacy price item' : 'price item';

    test.describe(`${editPage.name}: formula from the pivot table, prices from formula_price_margins`, () => {
        let ep: PriceItemEditPage;
        let s: Scenarios;

        test.beforeEach(async ({ page, request }) => {
            test.setTimeout(120_000); // the first test also searches the local data for suitable price items
            ep = new PriceItemEditPage(page);
            s = await getScenarios(request, editPage.legacy);
        });

        test.afterEach(async () => {
            ep.expectNoPageErrors();
        });

        /** Saved rows whose formula comes from the pivot. */
        function pivotRows(item: PriceItem): SavedRow[] {
            return savedRows(item).filter((row) => pivotRow(item, row.fabricCode, row.priceMarginId)?.formula_id != null);
        }

        async function gotoItem(item: PriceItem) {
            await ep.goto(item.id);
            // The controller shows the legacy page for Legacy items; make sure the item is the page's kind
            expect((await ep.priceItem()).type === 'Legacy', `${kind} ${item.id}`).toBe(editPage.legacy);
        }

        test('each saved row starts with the formula_id from the pivot table', async () => {
            test.skip(!s.withPivot, `No ${kind} with pivot formulas found`);
            const item = s.withPivot!;
            await gotoItem(item);

            let checked = 0;
            for (const row of pivotRows(item)) {
                const pivotFormulaId = Number(pivotRow(item, row.fabricCode, row.priceMarginId)!.formula_id);
                if (row.fabricCode) {
                    await expect(ep.fabricRow(row.fabricIndex).locator('.fabrics')).toHaveValue(row.fabricCode);
                }

                const options = await ep.options(row.fabricIndex, row.priceMarginId);
                if (!options.some((o) => o.id === pivotFormulaId)) {
                    continue; // pivot formula not offered for this row (its price margin isn't on the fabric row)
                }
                expect(
                    await ep.preselectedFormulaId(row.fabricIndex, row.priceMarginId),
                    `fabric ${row.fabricCode ?? '(none)'}, price margin ${row.priceMarginId}`
                ).toBe(pivotFormulaId);
                checked++;
            }
            expect(checked, 'rows checked').toBeGreaterThan(0);
        });

        test('dropdown options use the formula id as value and the formula text in data-formula-name', async () => {
            test.skip(!s.withPivot, `No ${kind} with pivot formulas found`);
            await gotoItem(s.withPivot!);
            const row = pivotRows(s.withPivot!)[0];
            const options = await ep.options(row.fabricIndex, row.priceMarginId);
            const formulas: { id: number; formula: string }[] = await ep.page.evaluate(() => (window as any).formulas);

            expect(options.length).toBeGreaterThan(0);
            for (const option of options) {
                expect(option.value).toMatch(/^\d+$/);
                const formula = formulas.find((f) => Number(f.id) === option.id);
                expect(option.formulaName, `data-formula-name of formula ${option.id}`).toBe(formula?.formula);
            }
        });

        test('without pivot rows, a saved row starts with the formula matching the saved text (as before)', async () => {
            test.skip(!s.withoutPivot, `No ${kind} without pivot rows found (the null formula_id test covers the fallback)`);
            const item = s.withoutPivot!;
            await gotoItem(item);

            let checked = 0;
            for (const row of savedRows(item).filter((r) => r.entry.formula)) {
                const options = await ep.options(row.fabricIndex, row.priceMarginId);
                if (!options.some((o) => o.formulaName === row.entry.formula)) {
                    continue; // saved formula not offered (as before, nothing is preselected)
                }
                const preselected = options.find((o) => o.preselected);
                expect(preselected?.formulaName, `fabric ${row.fabricCode ?? '(none)'}, price margin ${row.priceMarginId}`).toBe(
                    row.entry.formula
                );
                checked++;
            }
            expect(checked, 'rows checked').toBeGreaterThan(0);
        });

        test('the pivot formula wins over a different saved formula text', async () => {
            test.skip(!s.withPivot, `No ${kind} with pivot formulas found`);
            const item = s.withPivot!;

            // Find a row and another formula offered for it whose text differs from the saved one
            await gotoItem(item);
            let target: { row: SavedRow; otherId: number } | null = null;
            for (const row of pivotRows(item)) {
                const pivotFormulaId = Number(pivotRow(item, row.fabricCode, row.priceMarginId)!.formula_id);
                const other = (await ep.options(row.fabricIndex, row.priceMarginId)).find(
                    (o) => o.formulaName !== row.entry.formula && o.id !== pivotFormulaId
                );
                if (other) {
                    target = { row, otherId: other.id };
                    break;
                }
            }
            test.skip(!target, 'No row offers a second formula');
            const { row, otherId } = target!;

            // Reload with the pivot pointing at that other formula
            await ep.overridePivotFormula(row.fabricCode, row.priceMarginId, otherId);
            await gotoItem(item);

            expect(await ep.preselectedFormulaId(row.fabricIndex, row.priceMarginId)).toBe(otherId);
        });

        test('a pivot row with no formula_id falls back to the saved formula text', async () => {
            test.skip(!s.withPivot, `No ${kind} with pivot formulas found`);
            const item = s.withPivot!;
            await gotoItem(item);

            let target: SavedRow | null = null;
            for (const row of pivotRows(item).filter((r) => r.entry.formula)) {
                const options = await ep.options(row.fabricIndex, row.priceMarginId);
                if (options.some((o) => o.formulaName === row.entry.formula)) {
                    target = row;
                    break;
                }
            }
            test.skip(!target, 'No pivot row whose saved formula text is offered');

            await ep.overridePivotFormula(target!.fabricCode, target!.priceMarginId, null);
            await gotoItem(item);

            const preselected = (await ep.options(target!.fabricIndex, target!.priceMarginId)).find((o) => o.preselected);
            expect(preselected?.formulaName).toBe(target!.entry.formula);
        });

        test('size prices still show the saved properties values', async () => {
            const item = s.withPivot || s.withoutPivot;
            test.skip(!item, `No ${kind} found`);
            await gotoItem(item!);

            let checked = 0;
            for (const [fabricIndex, fabric] of parseProperties(item!).entries()) {
                for (const entry of fabric.fabric_price_margin_properties || []) {
                    const priceMarginId = Number(entry.price_margin_properties.price_margin_id);
                    const saved = (entry.sizes || []).map((size) => Object.values(size)[0]);
                    expect(
                        await ep.sizeValues(fabricIndex, priceMarginId),
                        `fabric ${fabric.fabric_code ?? '(none)'}, price margin ${priceMarginId}`
                    ).toEqual(saved);
                    checked++;
                }
            }
            expect(checked, 'rows checked').toBeGreaterThan(0);
        });

        /** A QC-on row with a selected formula whose base price margin row is on the same fabric. */
        async function findQcRow(item: PriceItem) {
            for (const row of savedRows(item).filter((r) => r.entry.qc_required && r.entry.formula)) {
                const selected = await ep.selectedFormula(row.fabricIndex, row.priceMarginId);
                if (!selected.formulaName) continue;
                const base = s.priceMargins.find((pm) => pm.name === legacyPriceMarginName(selected.formulaName!));
                if (base && (await ep.sizeInputs(row.fabricIndex, base.id).count()) > 0) {
                    return { row, selected, base };
                }
            }
            return null;
        }

        async function expectedFrom(fabricIndex: number, baseId: number, formulaText: string, current: string[]) {
            const baseValues = await ep.sizeValues(fabricIndex, baseId);
            // An empty base size leaves that size as it was (old page: eval error caught)
            return baseValues.map((value, i) => (value === '' ? current[i] : legacyCompute(formulaText, value)));
        }

        test('turning QC on recomputes every size from the base row like before', async () => {
            test.skip(!s.withQc, `No ${kind} with a QC-on row found`);
            await gotoItem(s.withQc!);
            const found = await findQcRow(s.withQc!);
            test.skip(!found, 'No QC-on row with its base price margin on the same fabric');
            const { row, selected, base } = found!;

            await ep.setQc(row.fabricIndex, row.priceMarginId, false);
            const before = await ep.sizeValues(row.fabricIndex, row.priceMarginId);
            await ep.setQc(row.fabricIndex, row.priceMarginId, true);

            expect(await ep.sizeValues(row.fabricIndex, row.priceMarginId)).toEqual(
                await expectedFrom(row.fabricIndex, base.id, selected.formulaName!, before)
            );
            const inputs = ep.sizeInputs(row.fabricIndex, row.priceMarginId);
            for (let i = 0; i < (await inputs.count()); i++) {
                await expect(inputs.nth(i)).toBeDisabled();
            }
        });

        test('changing the formula of a QC-on row recomputes with the new formula', async () => {
            test.skip(!s.withQc, `No ${kind} with a QC-on row found`);
            await gotoItem(s.withQc!);
            const found = await findQcRow(s.withQc!);
            test.skip(!found, 'No QC-on row with its base price margin on the same fabric');
            const { row, selected, base } = found!;

            const other = (await ep.options(row.fabricIndex, row.priceMarginId)).find(
                (o) => o.id !== selected.id && o.formulaName && legacyPriceMarginName(o.formulaName) === base.name
            );
            test.skip(!other, 'No second formula on the same base price margin');

            const before = await ep.sizeValues(row.fabricIndex, row.priceMarginId);
            await ep.selectFormula(row.fabricIndex, row.priceMarginId, other!.id);

            expect(await ep.sizeValues(row.fabricIndex, row.priceMarginId)).toEqual(
                await expectedFrom(row.fabricIndex, base.id, other!.formulaName!, before)
            );
        });

        test('a formula with parentheses recomputes a QC-on row (rows with the parentheses column)', async ({ page }) => {
            test.skip(!s.withQc, `No ${kind} with a QC-on row found`);

            // Find the QC-on row and its base price margin first (plain page load)
            await gotoItem(s.withQc!);
            const found = await findQcRow(s.withQc!);
            test.skip(!found, 'No QC-on row with its base price margin on the same fabric');
            const { row, base } = found!;

            // Synthetic formula: <base> * ( <base> + 2 ), stored like the formula create page saves it
            const synthetic: Formula = {
                id: 990002,
                name: 'Playwright parentheses',
                formula: `${base.name} | * | ( | ${base.name} | + | 2 | )`,
                formula_price_margins: [
                    { index_in_formula: 0, price_margin_id: base.id, operator: null, parentheses: null, variable: null },
                    { index_in_formula: 1, price_margin_id: null, operator: '*', parentheses: null, variable: null },
                    { index_in_formula: 2, price_margin_id: null, operator: null, parentheses: '(', variable: null },
                    { index_in_formula: 3, price_margin_id: base.id, operator: null, parentheses: null, variable: null },
                    { index_in_formula: 4, price_margin_id: null, operator: '+', parentheses: null, variable: null },
                    { index_in_formula: 5, price_margin_id: null, operator: null, parentheses: null, variable: 2 },
                    { index_in_formula: 6, price_margin_id: null, operator: null, parentheses: ')', variable: null },
                ],
            };
            await page.route('**/api/formulas/**', async (route) => {
                const response = await route.fetch();
                const body = await response.json();
                body.formulas.push(synthetic);
                await route.fulfill({ response, json: body });
            });
            await gotoItem(s.withQc!);

            await expect
                .poll(async () => (await ep.options(row.fabricIndex, row.priceMarginId)).map((o) => o.id))
                .toContain(synthetic.id);

            const before = await ep.sizeValues(row.fabricIndex, row.priceMarginId);
            await ep.selectFormula(row.fabricIndex, row.priceMarginId, synthetic.id);

            // Each size: b * (b + 2) from the base row; without the parentheses it would be b * b + 2.
            // An empty base size leaves that size as it was.
            const baseValues = await ep.sizeValues(row.fabricIndex, base.id);
            expect(baseValues.some((value) => value !== ''), 'the base row has at least one size value').toBe(true);
            expect(await ep.sizeValues(row.fabricIndex, row.priceMarginId)).toEqual(
                baseValues.map((value, i) => (value === '' ? before[i] : roundLikePage(Number(value) * (Number(value) + 2))))
            );
        });

        test('the saved properties keep the formula text and add formula_id', async () => {
            test.skip(!s.withPivot, `No ${kind} with pivot formulas found`);
            const item = s.withPivot!;
            await gotoItem(item);

            const expected = [];
            for (const row of savedRows(item)) {
                const selected = await ep.selectedFormula(row.fabricIndex, row.priceMarginId);
                expected.push({ row, selected });
            }

            const fabrics = await ep.readPropertiesToBeSaved();
            for (const { row, selected } of expected) {
                const entry = fabrics[row.fabricIndex].fabric_price_margin_properties.find(
                    (e) => Number(e.price_margin_properties.price_margin_id) === row.priceMarginId
                );
                expect(entry, `fabric ${row.fabricCode ?? '(none)'}, price margin ${row.priceMarginId}`).toMatchObject({
                    formula: selected.formulaName,
                    formula_id: selected.id,
                });
            }
        });
    });
}
