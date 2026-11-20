import { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures';
import { AddOnsPage } from './helpers/addOnsPage';
import {
    AddOn,
    FACTORY_COST_ID,
    FACTORY_COST_NAME,
    FixedAmountDetail,
    Formula,
    PriceMargin,
    expectedLabel,
    getAddOns,
    getFormulas,
    getPriceMargins,
    legacyCompute,
    legacyListedFormulaIds,
    legacyPriceMarginName,
    roundLikePage,
} from '../helpers/formulas';

/**
 * Add-ons edit page (/admin/master_add_on/edit/{id}), Fixed Amount section, on an existing local add-on.
 * Expected values come from the OLD string-splitting logic. Nothing is saved.
 */

interface Candidate {
    addOn: AddOn;
    detail: FixedAmountDetail;
    formula: Formula;
    formulas: Formula[];
    /** Price margin names on the page when this detail's dropdown was built. */
    includedBefore: string[];
    priceMargins: PriceMargin[];
}

let candidate: Candidate | null | undefined;

/** First fixed-amount add-on with a saved formula that the old page would also have listed. */
async function findCandidate(request: APIRequestContext): Promise<Candidate | null> {
    if (candidate !== undefined) {
        return candidate;
    }

    const priceMargins = await getPriceMargins(request);
    const nameById = new Map(priceMargins.map((pm) => [pm.id, pm.name]));
    const formulasByBrand = new Map<string, Formula[]>();

    candidate = null;
    for (const addOn of await getAddOns(request)) {
        let type: { type?: string };
        let details: FixedAmountDetail[];
        try {
            type = JSON.parse(addOn.type);
            details = JSON.parse(addOn.pricing_details);
        } catch {
            continue;
        }
        // Skip the add-ons saved by tests/e2e (multi price margin formula the old string-split logic can't check)
        const name = String((addOn as any).add_on_name || '');
        if (type.type !== 'fixed_amount' || !Array.isArray(details) || name.startsWith('Playwright E2E')) {
            continue;
        }

        const brandId = String(addOn.brand_id);
        if (!formulasByBrand.has(brandId)) {
            formulasByBrand.set(brandId, await getFormulas(request, brandId));
        }
        const formulas = formulasByBrand.get(brandId)!;

        const included = [FACTORY_COST_NAME];
        for (const detail of details) {
            if (detail.price_margin_id == FACTORY_COST_ID) {
                continue;
            }

            const listed = legacyListedFormulaIds(formulas, included);
            const formulaId = Number(detail.formula_id);
            if (detail.formula_id && listed.includes(formulaId)) {
                candidate = {
                    addOn,
                    detail,
                    formula: formulas.find((f) => Number(f.id) === formulaId)!,
                    formulas,
                    includedBefore: [...included],
                    priceMargins,
                };
                return candidate;
            }

            const name = nameById.get(Number(detail.price_margin_id));
            if (name) {
                included.push(name);
            }
        }
    }

    return candidate;
}

test.describe('Add-ons edit page: formulas from formula_price_margins', () => {
    let addOns: AddOnsPage;
    let c: Candidate;

    test.beforeEach(async ({ page, request }) => {
        const found = await findCandidate(request);
        test.skip(!found, 'No local fixed-amount add-on has a saved formula the page would list');
        c = found!;

        addOns = new AddOnsPage(page);
        await addOns.gotoEdit(c.addOn.id);
    });

    test.afterEach(async () => {
        addOns.expectNoPageErrors();
    });

    test('saved formula is still pre-selected', async () => {
        const priceMarginId = Number(c.detail.price_margin_id);
        await expect(addOns.formulaSelect(priceMarginId)).toHaveValue(String(c.formula.id));
    });

    test('dropdown lists the same formulas as before, with matching labels', async () => {
        const priceMarginId = Number(c.detail.price_margin_id);
        const expectedIds = legacyListedFormulaIds(c.formulas, c.includedBefore);

        expect(await addOns.listedFormulaIds(priceMarginId)).toEqual(expectedIds);
        for (const id of expectedIds) {
            const formula = c.formulas.find((f) => Number(f.id) === id)!;
            expect(await addOns.optionLabel(priceMarginId, id), `label of formula ${id}`).toBe(expectedLabel(formula.formula));
        }
    });

    test('toggling the saved formula recomputes like before', async () => {
        const priceMarginId = Number(c.detail.price_margin_id);

        // Value the formula starts from: Factory Cost, or the value of the formula's own price margin
        const baseName = legacyPriceMarginName(c.formula.formula);
        const base = c.priceMargins.find((pm) => pm.name === baseName)!;
        const startValue =
            base.id === FACTORY_COST_ID ? await addOns.factoryCostValue() : await addOns.valueInput(base.id).inputValue();

        await addOns.setToggle(priceMarginId, false);
        await addOns.setToggle(priceMarginId, true);

        await expect(addOns.valueInput(priceMarginId)).toHaveValue(legacyCompute(c.formula.formula, startValue));
    });

    test('a formula with parentheses (rows with the parentheses column)', async ({ page }) => {
        const priceMarginId = Number(c.detail.price_margin_id);
        const base = c.priceMargins.find((pm) => pm.name === legacyPriceMarginName(c.formula.formula))!;

        // Synthetic formula: <base> * ( <base> + 2 ); one price margin, already on the page for the saved formula
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

        // The dropdowns are built on load from /api/formulas/{brand}: add the formula, then open the page again
        await page.route('**/api/formulas/**', async (route) => {
            const response = await route.fetch();
            const body = await response.json();
            body.formulas.push(synthetic);
            await route.fulfill({ response, json: body });
        });
        await addOns.gotoEdit(c.addOn.id);
        await page.evaluate((formula) => {
            const w = window as any;
            if (Array.isArray(w.formulas)) {
                if (!w.formulas.some((f: Formula) => Number(f.id) === formula.id)) w.formulas.push(formula);
            } else if (w.formulas) {
                w.formulas[formula.id] = formula;
            }
        }, synthetic);

        await expect.poll(() => addOns.listedFormulaIds(priceMarginId)).toContain(synthetic.id);
        expect(await addOns.optionLabel(priceMarginId, synthetic.id)).toBe(`${base.name} * ( ${base.name} + 2 )`);

        const startValue =
            base.id === FACTORY_COST_ID ? await addOns.factoryCostValue() : await addOns.valueInput(base.id).inputValue();
        const v = Number(startValue);

        await addOns.setToggle(priceMarginId, false);
        await addOns.selectFormula(priceMarginId, synthetic.id);
        await addOns.setToggle(priceMarginId, true);

        // v * (v + 2); without the parentheses it would be v * v + 2
        await expect(addOns.valueInput(priceMarginId)).toHaveValue(roundLikePage(v * (v + 2)));
    });
});
