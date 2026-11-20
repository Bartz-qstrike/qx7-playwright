import { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { CreatePage, FACTORY_COST_ID, PriceItemCreatePage } from './priceItemCreatePage';
import {
    FACTORY_COST_NAME,
    Formula,
    PriceMargin,
    getFormulas,
    getPriceMargins,
    legacyCompute,
    legacyListedFormulaIds,
    legacyPriceMarginName,
    roundLikePage,
} from '../../helpers/formulas';

/**
 * Shared tests for the price item create pages (/admin/price_items/add and the legacy /admin/price_item/add_legacy,
 * which share the same controls and formula code): formula dropdown and price calculation from formula_price_margins.
 * Each page has its own spec file that calls defineCreatePageTests() with its page. Expected values come from the OLD string-splitting logic, so every check means
 * "new page = old page". Nothing is saved (the store URL is blocked and the item name is left empty).
 */

interface Scenario {
    brandId: string;
    formulas: Formula[];
    priceMargins: PriceMargin[];
    /** Formulas based on Factory Cost (at least 2). */
    fcFormulas: Formula[];
    /** A formula based on another price margin that can be added on the page. */
    other: { priceMargin: PriceMargin; formula: Formula };
    /** Sport that gives the brand a size group with sizes (found by the first test). */
    sport?: string;
}

/** Found once per page (keyed by path) and reused by its later tests. */
const scenarios = new Map<string, Scenario | null>();

async function findScenario(pi: PriceItemCreatePage, request: APIRequestContext): Promise<Scenario | null> {
    if (scenarios.has(pi.path)) {
        return scenarios.get(pi.path)!;
    }
    let scenario: Scenario | null = null;

    const priceMargins = await getPriceMargins(request);
    const byName = new Map(priceMargins.map((pm) => [pm.name, pm]));
    const selectable = await pi.selectablePriceMarginIds();

    for (const brandId of await pi.brandIds()) {
        const formulas = (await getFormulas(request, brandId)).filter((f) => f.name);
        const fcFormulas = formulas.filter((f) => legacyPriceMarginName(f.formula) === FACTORY_COST_NAME);
        const otherFormula = formulas.find((f) => {
            const pm = byName.get(legacyPriceMarginName(f.formula));
            return pm && pm.id !== FACTORY_COST_ID && selectable.includes(pm.id);
        });

        if (fcFormulas.length >= 2 && otherFormula) {
            scenario = {
                brandId,
                formulas,
                priceMargins,
                fcFormulas,
                other: { priceMargin: byName.get(legacyPriceMarginName(otherFormula.formula))!, formula: otherFormula },
            };
            break;
        }
    }

    scenarios.set(pi.path, scenario);
    return scenario;
}

/** Old option label: the formula's name with " x " sequences collapsed (as the page always did). */
function legacyOptionLabel(formula: Formula): string {
    return String(formula.name).replace(/ . /g, ' ').trim();
}

function expectedSizes(formula: Formula, sourceValues: string[]): string[] {
    return sourceValues.map((value) => legacyCompute(formula.formula, value));
}

export function defineCreatePageTests(createPage: CreatePage) {
    test.describe(`${createPage.name}: formulas from formula_price_margins`, () => {
        let pi: PriceItemCreatePage;
        let s: Scenario;
        let sizeCount: number;
        /** Price margins (not Factory Cost, not the "other" base) to use as computed rows. */
        let targets: number[];

        test.beforeEach(async ({ page, request }) => {
            pi = new PriceItemCreatePage(page, createPage.path);
            await pi.goto();

            const found = await findScenario(pi, request);
            test.skip(!found, 'No brand has two Factory Cost formulas and a formula based on another price margin');
            s = found!;

            await pi.selectBrand(s.brandId);
            const chosen = await pi.selectSportWithSizes(s.sport);
            test.skip(chosen.sizes === 0, 'No sport gives this brand a size group with sizes');
            s.sport = chosen.sport!; // remembered so later tests try it first
            sizeCount = chosen.sizes;

            const selectable = await pi.selectablePriceMarginIds();
            targets = selectable.filter((id) => id !== FACTORY_COST_ID && id !== s.other.priceMargin.id);
        });

        test.afterEach(async () => {
            pi.expectNoPageErrors();
        });

        /** Source values for each size column, e.g. ['12.50', '40.00', '7.25']. */
        function sourceValues(seed: number): string[] {
            return Array.from({ length: sizeCount }, (_, i) => (seed + i * 11.25).toFixed(2));
        }

        test('dropdown lists the same formulas as before, with the id as value and the text in data-formula-name', async () => {
            const target = targets[0];
            await pi.addPriceMargin(target);

            const expectedIds = legacyListedFormulaIds(s.formulas, [FACTORY_COST_NAME]);
            expect(await pi.listedFormulaIds(target)).toEqual(expectedIds);

            for (const id of expectedIds) {
                const formula = s.formulas.find((f) => Number(f.id) === id)!;
                const option = await pi.option(target, id);
                expect(option.formulaName, `data-formula-name of formula ${id}`).toBe(formula.formula);
                expect(option.label, `label of formula ${id}`).toBe(legacyOptionLabel(formula));
            }
        });

        test('QC on with a Factory Cost formula computes every size like before', async () => {
            const target = targets[0];
            const formula = s.fcFormulas[0];
            const fc = sourceValues(12.5);

            await pi.setSizes(FACTORY_COST_ID, fc);
            await pi.addPriceMargin(target);
            await pi.selectFormula(target, formula.id);
            await pi.setQc(target, true);

            expect(await pi.sizeValues(target)).toEqual(expectedSizes(formula, fc));
            for (let i = 0; i < sizeCount; i++) {
                await expect(pi.sizeInputs(target).nth(i)).toBeDisabled();
            }
        });

        test('recomputes when a Factory Cost size or the formula changes', async () => {
            const target = targets[0];
            const [first, second] = s.fcFormulas;
            const fc = sourceValues(20);

            await pi.setSizes(FACTORY_COST_ID, fc);
            await pi.addPriceMargin(target);
            await pi.selectFormula(target, first.id);
            await pi.setQc(target, true);
            expect(await pi.sizeValues(target)).toEqual(expectedSizes(first, fc));

            const changed = [...fc];
            changed[0] = '99.90';
            await pi.setSizes(FACTORY_COST_ID, changed);
            expect(await pi.sizeValues(target)).toEqual(expectedSizes(first, changed));

            await pi.selectFormula(target, second.id);
            expect(await pi.sizeValues(target)).toEqual(expectedSizes(second, changed));
        });

        test('a formula based on another price margin uses that row\'s sizes', async () => {
            const base = s.other.priceMargin.id;
            const target = targets[0];
            const baseValues = sourceValues(80);

            await pi.setSizes(FACTORY_COST_ID, sourceValues(5));
            await pi.addPriceMargin(base);
            await pi.setSizes(base, baseValues);
            await pi.addPriceMargin(target);

            expect(await pi.listedFormulaIds(target)).toContain(Number(s.other.formula.id));

            await pi.selectFormula(target, s.other.formula.id);
            await pi.setQc(target, true);

            expect(await pi.sizeValues(target)).toEqual(expectedSizes(s.other.formula, baseValues));
        });

        test('an empty source size leaves that size unchanged and computes the others', async () => {
            test.skip(sizeCount < 2, 'Needs at least two sizes');
            const base = s.other.priceMargin.id;
            const target = targets[0];
            const baseValues = sourceValues(60);

            await pi.addPriceMargin(base);
            await pi.setSizes(base, baseValues);
            await pi.addPriceMargin(target);
            await pi.setSizes(target, Array(sizeCount).fill('5.00'));
            await pi.clearSizeSilently(base, 1);

            await pi.selectFormula(target, s.other.formula.id);
            await pi.setQc(target, true);

            const expected = expectedSizes(s.other.formula, baseValues);
            expected[1] = '5.00';
            expect(await pi.sizeValues(target)).toEqual(expected);
        });

        test('a price margin used by a QC-on formula cannot be deleted', async () => {
            const base = s.other.priceMargin.id;
            const target = targets[0];

            await pi.addPriceMargin(base);
            await pi.setSizes(base, sourceValues(30));
            await pi.addPriceMargin(target);
            await pi.selectFormula(target, s.other.formula.id);
            await pi.setQc(target, true);

            await pi.deleteRow(base);

            await expect(pi.lastToast()).toContainText('Cannot Delete Price Margin! Price Margin is used in other formula');
            await expect(pi.priceMarginRow(base)).toBeVisible();
        });

        test('deleting a price margin that no QC-on row uses removes it and its formulas', async () => {
            const base = s.other.priceMargin.id;
            const target = targets[0];

            await pi.addPriceMargin(base);
            await pi.addPriceMargin(target);
            expect(await pi.listedFormulaIds(target)).toContain(Number(s.other.formula.id));

            await pi.deleteRow(base);

            await expect(pi.priceMarginRow(base)).toHaveCount(0);
            expect(await pi.listedFormulaIds(target)).not.toContain(Number(s.other.formula.id));
        });

        test('the saved properties keep the formula text and add formula_id', async () => {
            const target = targets[0];
            const formula = s.fcFormulas[0];

            await pi.setSizes(FACTORY_COST_ID, sourceValues(10));
            await pi.addPriceMargin(target);
            await pi.selectFormula(target, formula.id);
            await pi.setQc(target, true);

            const entries = await pi.readPropertiesToBeSaved();
            const targetEntry = entries.find((e) => Number(e.price_margin_properties.price_margin_id) === target)!;
            const fcEntry = entries.find((e) => Number(e.price_margin_properties.price_margin_id) === FACTORY_COST_ID)!;

            expect(targetEntry).toMatchObject({ qc_required: 1, formula: formula.formula, formula_id: Number(formula.id) });
            expect(fcEntry).toMatchObject({ formula: null, formula_id: null });
        });

        test('a formula with several price margins (new behaviour)', async ({ page }) => {
            test.skip(targets.length < 2, 'Needs two more price margins on the page');
            const second = s.other.priceMargin;
            const [before, after] = targets;
            const fc = sourceValues(100);
            const secondValues = sourceValues(20);

            // Synthetic formula: Factory Cost (FC) + <second> * 1.1 (no such formula exists in the data yet)
            const synthetic: Formula = {
                id: 990001,
                name: 'Playwright multi price margin',
                formula: `${FACTORY_COST_NAME} | + | ${second.name} | * | 1.1`,
                formula_price_margins: [
                    { index_in_formula: 0, price_margin_id: FACTORY_COST_ID, operator: null, variable: null },
                    { index_in_formula: 1, price_margin_id: null, operator: '+', variable: null },
                    { index_in_formula: 2, price_margin_id: second.id, operator: null, variable: null },
                    { index_in_formula: 3, price_margin_id: null, operator: '*', variable: null },
                    { index_in_formula: 4, price_margin_id: null, operator: null, variable: 1.1 },
                ],
            };
            // The page reads both the dropdown and the computation from /api/formulas/{brand}.
            await page.route('**/api/formulas/**', async (route) => {
                const response = await route.fetch();
                const body = await response.json();
                body.formulas.push(synthetic);
                await route.fulfill({ response, json: body });
            });

            await pi.setSizes(FACTORY_COST_ID, fc);

            // Not listed while <second> isn't on this fabric row yet
            await pi.addPriceMargin(before);
            expect(await pi.listedFormulaIds(before)).not.toContain(synthetic.id);

            // Listed once Factory Cost and <second> are both on the row
            await pi.addPriceMargin(second.id);
            await pi.setSizes(second.id, secondValues);
            await pi.addPriceMargin(after);
            expect(await pi.listedFormulaIds(after)).toContain(synthetic.id);

            // Each size: FC size + <second> size * 1.1 (same precedence as the page's eval)
            await pi.selectFormula(after, synthetic.id);
            await pi.setQc(after, true);
            expect(await pi.sizeValues(after)).toEqual(
                fc.map((value, i) => roundLikePage(Number(value) + Number(secondValues[i]) * 1.1))
            );
        });

        test('a formula with parentheses (rows with the parentheses column)', async ({ page }) => {
            const second = s.other.priceMargin;
            const target = targets[0];
            const fc = sourceValues(10);
            const secondValues = sourceValues(3);

            // Synthetic formula: Factory Cost (FC) * ( <second> + 2 ), stored like the formula create page saves it
            const synthetic: Formula = {
                id: 990002,
                name: 'Playwright parentheses',
                formula: `${FACTORY_COST_NAME} | * | ( | ${second.name} | + | 2 | )`,
                formula_price_margins: [
                    { index_in_formula: 0, price_margin_id: FACTORY_COST_ID, operator: null, parentheses: null, variable: null },
                    { index_in_formula: 1, price_margin_id: null, operator: '*', parentheses: null, variable: null },
                    { index_in_formula: 2, price_margin_id: null, operator: null, parentheses: '(', variable: null },
                    { index_in_formula: 3, price_margin_id: second.id, operator: null, parentheses: null, variable: null },
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

            await pi.setSizes(FACTORY_COST_ID, fc);
            await pi.addPriceMargin(second.id);
            await pi.setSizes(second.id, secondValues);
            await pi.addPriceMargin(target);
            expect(await pi.listedFormulaIds(target)).toContain(synthetic.id);

            // Each size: FC size * (<second> size + 2); without the parentheses it would be FC * <second> + 2
            await pi.selectFormula(target, synthetic.id);
            await pi.setQc(target, true);
            expect(await pi.sizeValues(target)).toEqual(
                fc.map((value, i) => roundLikePage(Number(value) * (Number(secondValues[i]) + 2)))
            );
        });
    });
}
