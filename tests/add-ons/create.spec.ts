import { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures';
import { AddOnsPage } from './helpers/addOnsPage';
import {
    FACTORY_COST_ID,
    FACTORY_COST_NAME,
    Formula,
    PriceMargin,
    expectedLabel,
    getFormulas,
    getPriceMargins,
    legacyCompute,
    legacyListedFormulaIds,
    legacyPriceMarginName,
    roundLikePage,
} from '../helpers/formulas';

/**
 * Add-ons create page (/admin/master_add_on/add), Fixed Amount section.
 * Expected values come from the OLD string-splitting logic, so every check means "new page = old page".
 * Nothing is saved.
 */

interface Scenario {
    brandId: string;
    formulas: Formula[];
    priceMargins: PriceMargin[];
    /** Formulas based on Factory Cost (at least 2). */
    fcFormulas: Formula[];
    /** A formula based on another selectable price margin, if the brand has one. */
    other?: { priceMargin: PriceMargin; formula: Formula };
    /** Selectable price margin ids (the page's "VALUE" dropdown). */
    selectable: number[];
}

let scenario: Scenario | null | undefined;

async function findScenario(addOns: AddOnsPage, request: APIRequestContext): Promise<Scenario | null> {
    if (scenario !== undefined) {
        return scenario;
    }

    const priceMargins = await getPriceMargins(request);
    const byName = new Map(priceMargins.map((pm) => [pm.name, pm]));
    const selectable = await addOns.selectablePriceMarginIds();

    scenario = null;
    for (const brandId of await addOns.brandIds()) {
        const formulas = await getFormulas(request, brandId);
        const fcFormulas = formulas.filter((f) => legacyPriceMarginName(f.formula) === FACTORY_COST_NAME);
        if (fcFormulas.length < 2) {
            continue;
        }

        const otherFormula = formulas.find((f) => {
            const pm = byName.get(legacyPriceMarginName(f.formula));
            return pm && pm.id !== FACTORY_COST_ID && selectable.includes(pm.id);
        });

        scenario = {
            brandId,
            formulas,
            priceMargins,
            fcFormulas,
            selectable,
            other: otherFormula
                ? { priceMargin: byName.get(legacyPriceMarginName(otherFormula.formula))!, formula: otherFormula }
                : undefined,
        };

        if (scenario.other) {
            break; // best case: has both kinds of formulas
        }
    }

    return scenario;
}

function pickOther(selectable: number[], exclude: number[]): number {
    const id = selectable.find((candidate) => !exclude.includes(candidate));
    if (id === undefined) {
        throw new Error('Not enough selectable price margins on the page');
    }
    return id;
}

test.describe('Add-ons create page: formulas from formula_price_margins', () => {
    let addOns: AddOnsPage;
    let s: Scenario;

    test.beforeEach(async ({ page, request }) => {
        addOns = new AddOnsPage(page);
        await addOns.gotoCreate();

        const found = await findScenario(addOns, request);
        test.skip(!found, 'No brand has at least two Factory Cost formulas in local data');
        s = found!;

        await addOns.selectBrand(s.brandId);
    });

    test.afterEach(async () => {
        addOns.expectNoPageErrors();
    });

    test('dropdown lists the same formulas as before, with matching labels', async () => {
        const target = pickOther(s.selectable, []);
        await addOns.addPriceMargin(target);

        const expectedIds = legacyListedFormulaIds(s.formulas, [FACTORY_COST_NAME]);
        expect(await addOns.listedFormulaIds(target)).toEqual(expectedIds);

        for (const id of expectedIds) {
            const formula = s.formulas.find((f) => Number(f.id) === id)!;
            expect(await addOns.optionLabel(target, id), `label of formula ${id}`).toBe(expectedLabel(formula.formula));
        }
    });

    test('fixed amount from a Factory Cost formula matches the old computation', async () => {
        const target = pickOther(s.selectable, []);
        const formula = s.fcFormulas[0];

        await addOns.setFactoryCost('123.45');
        await addOns.addPriceMargin(target);
        await addOns.selectFormula(target, formula.id);
        await addOns.setToggle(target, true);

        await expect(addOns.valueInput(target)).toHaveValue(legacyCompute(formula.formula, '123.45'));
        await expect(addOns.valueInput(target)).toHaveAttribute('readonly', /.*/);
    });

    test('recomputes when the Factory Cost value or the formula changes', async () => {
        const target = pickOther(s.selectable, []);
        const [first, second] = s.fcFormulas;

        await addOns.setFactoryCost('100.00');
        await addOns.addPriceMargin(target);
        await addOns.selectFormula(target, first.id);
        await addOns.setToggle(target, true);
        await expect(addOns.valueInput(target)).toHaveValue(legacyCompute(first.formula, '100.00'));

        await addOns.setFactoryCost('57.80');
        await expect(addOns.valueInput(target)).toHaveValue(legacyCompute(first.formula, '57.80'));

        await addOns.selectFormula(target, second.id);
        await expect(addOns.valueInput(target)).toHaveValue(legacyCompute(second.formula, '57.80'));
    });

    test('a formula based on another price margin uses that price margin value', async () => {
        test.skip(!s.other, 'This brand has no formula based on a selectable price margin');
        const base = s.other!.priceMargin.id;
        const formula = s.other!.formula;
        const target = pickOther(s.selectable, [base]);

        await addOns.setFactoryCost('10.00');
        await addOns.addPriceMargin(base);
        await addOns.setValue(base, '80.00');
        await addOns.addPriceMargin(target);

        expect(await addOns.listedFormulaIds(target)).toContain(Number(formula.id));

        await addOns.selectFormula(target, formula.id);
        await addOns.setToggle(target, true);

        await expect(addOns.valueInput(target)).toHaveValue(legacyCompute(formula.formula, '80.00'));
    });

    test('an empty base price margin value shows an error and switches the toggle off', async () => {
        test.skip(!s.other, 'This brand has no formula based on a selectable price margin');
        const base = s.other!.priceMargin;
        const formula = s.other!.formula;
        const target = pickOther(s.selectable, [base.id]);

        await addOns.addPriceMargin(base.id);
        await addOns.addPriceMargin(target);
        await addOns.selectFormula(target, formula.id);
        await addOns.clearValueSilently(base.id);

        await addOns.clickToggle(target);

        await expect(addOns.lastToast()).toContainText(`${base.name} cannot be empty!`);
        await expect(addOns.toggle(target)).not.toBeChecked();
        await expect(addOns.valueInput(target)).not.toHaveAttribute('readonly', /.*/);
    });

    test('a formula with several price margins (new behaviour)', async ({ page }) => {
        const second = s.priceMargins.find((pm) => pm.id !== FACTORY_COST_ID && s.selectable.includes(pm.id))!;
        const before = pickOther(s.selectable, [second.id]);
        const after = pickOther(s.selectable, [second.id, before]);

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

        // The dropdown comes from /api/formulas/{brand}; the computation reads the page's global `formulas`.
        await page.route('**/api/formulas/**', async (route) => {
            const response = await route.fetch();
            const body = await response.json();
            body.formulas.push(synthetic);
            await route.fulfill({ response, json: body });
        });
        await page.evaluate((formula) => {
            const w = window as any;
            if (Array.isArray(w.formulas)) {
                w.formulas.push(formula);
            } else {
                w.formulas[formula.id] = formula;
            }
        }, synthetic);

        await addOns.setFactoryCost('100.00');

        // Not listed while <second> isn't on the page yet
        await addOns.addPriceMargin(before);
        expect(await addOns.listedFormulaIds(before)).not.toContain(synthetic.id);

        // Listed once both Factory Cost and <second> are on the page
        await addOns.addPriceMargin(second.id);
        await addOns.setValue(second.id, '20.00');
        await addOns.addPriceMargin(after);
        expect(await addOns.listedFormulaIds(after)).toContain(synthetic.id);
        expect(await addOns.optionLabel(after, synthetic.id)).toBe(`${FACTORY_COST_NAME} + ${second.name} * 1.1`);

        // Same precedence as the page's eval: 100 + 20 * 1.1
        await addOns.selectFormula(after, synthetic.id);
        await addOns.setToggle(after, true);
        await expect(addOns.valueInput(after)).toHaveValue(roundLikePage(100 + 20 * 1.1));

        // Missing value for the second price margin
        await addOns.setToggle(after, false);
        await addOns.clearValueSilently(second.id);
        await addOns.clickToggle(after);
        await expect(addOns.lastToast()).toContainText(`${second.name} cannot be empty!`);
        await expect(addOns.toggle(after)).not.toBeChecked();
    });

    test('a formula with parentheses (rows with the parentheses column)', async ({ page }) => {
        const second = s.priceMargins.find((pm) => pm.id !== FACTORY_COST_ID && s.selectable.includes(pm.id))!;
        const target = pickOther(s.selectable, [second.id]);

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

        // The dropdown comes from /api/formulas/{brand}; the computation reads the page's global `formulas`.
        await page.route('**/api/formulas/**', async (route) => {
            const response = await route.fetch();
            const body = await response.json();
            body.formulas.push(synthetic);
            await route.fulfill({ response, json: body });
        });
        await page.evaluate((formula) => {
            const w = window as any;
            if (Array.isArray(w.formulas)) {
                w.formulas.push(formula);
            } else {
                w.formulas[formula.id] = formula;
            }
        }, synthetic);

        await addOns.setFactoryCost('100.00');
        await addOns.addPriceMargin(second.id);
        await addOns.setValue(second.id, '20.00');
        await addOns.addPriceMargin(target);

        expect(await addOns.listedFormulaIds(target)).toContain(synthetic.id);
        expect(await addOns.optionLabel(target, synthetic.id)).toBe(`${FACTORY_COST_NAME} * ( ${second.name} + 2 )`);

        // 100 * (20 + 2) = 2200.00; without the parentheses it would be 100 * 20 + 2 = 2002.00
        await addOns.selectFormula(target, synthetic.id);
        await addOns.setToggle(target, true);
        await expect(addOns.valueInput(target)).toHaveValue(roundLikePage(100 * (20 + 2)));
    });

    test.fixme('pricing grid computes every cell like before', async () => {
        // The "Pricing Grid" type radio is disabled on the page ("currently disabled for maintenance"),
        // so a user can't reach this section. Enable this test once the feature is turned back on.
    });
});
