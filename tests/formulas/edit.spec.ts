import { test, expect } from '../fixtures';
import { expectedLabel, Formula, FormulaRow, getFormulas } from '../helpers/formulas';
import { FormulaEditPage, getFormula, linesFromRows, REWRITE_HTML_CHROME_ARGS } from './helpers/formulaEditPage';

/**
 * Formula edit page (/admin/formula/edit/{id}): the line builder, loaded from the formula's formula_price_margins
 * rows (not from the formula text). SAVE posts the text and the rows, like the create page.
 * Nothing is saved: the submit is cancelled in the page and the update URL is blocked.
 */
const BRAND_ID = 3;

// Two tests change the page HTML in the browser only; launch options can only be set per file
test.use({ launchOptions: { args: REWRITE_HTML_CHROME_ARGS } });

/** The rows as the page posts them back: one key per row, numbers as JS prints them. */
function postedRows(rows: FormulaRow[]): Record<string, unknown>[] {
    return [...rows]
        .sort((a, b) => a.index_in_formula - b.index_in_formula)
        .map((row) => {
            if (row.price_margin_id != null) return { price_margin_id: Number(row.price_margin_id) };
            if (row.parentheses != null) return { parentheses: row.parentheses };
            if (row.operator != null) return { operator: row.operator };
            return { variable: String(Number(row.variable)) };
        });
}

/** First formula in the list whose `formula` (text) passes the check, with its rows from /api/formula/{id}. */
let formulas: Formula[] | null = null;
async function pick(request: Parameters<typeof getFormulas>[0], accept: (f: Formula) => boolean): Promise<Formula | null> {
    formulas = formulas ?? (await getFormulas(request, BRAND_ID));
    const found = formulas.find((f) => f.formula_price_margins.length > 0 && accept(f));
    return found ? getFormula(request, Number(found.id)) : null;
}

const twoOperations = (f: Formula) => f.formula_price_margins.length === 5;
const withParentheses = (f: Formula) => f.formula_price_margins.some((row) => row.parentheses != null);

test.describe('Formula edit page: line builder loaded from formula_price_margins', () => {
    let fp: FormulaEditPage;

    test.beforeEach(async ({ page }) => {
        fp = new FormulaEditPage(page);
    });

    test.afterEach(async () => {
        fp.expectNoPageErrors();
    });

    test('the lines and the preview follow the saved rows; name and brands are still filled', async ({ request }) => {
        const formula = await pick(request, twoOperations);
        test.skip(!formula, `no formula with 5 rows for brand ${BRAND_ID}`);

        await fp.gotoFormula(formula!.id);

        expect(await fp.shownLines()).toEqual(linesFromRows(formula!.formula_price_margins));
        await expect(fp.preview()).toHaveText(expectedLabel(formula!.formula));
        await expect(fp.page.locator('#name')).toHaveValue(formula!.name ?? '');
        const brands = await fp.page.locator('#brand_ids').evaluate((el: HTMLSelectElement) =>
            Array.from(el.selectedOptions).map((o) => o.value).sort(),
        );
        expect(brands).toEqual((JSON.parse(formula!.brand_ids ?? '[]') as string[]).map(String).sort());
    });

    test('a formula with parentheses shows them on the right lines', async ({ request }) => {
        const formula = await pick(request, withParentheses);
        test.skip(!formula, `no formula with parentheses for brand ${BRAND_ID}`);

        await fp.gotoFormula(formula!.id);

        const lines = await fp.shownLines();
        expect(lines).toEqual(linesFromRows(formula!.formula_price_margins));
        expect(lines.some((line) => line.open)).toBe(true);
        expect(lines.some((line) => line.close)).toBe(true);
        await expect(fp.preview()).toHaveText(expectedLabel(formula!.formula));
    });

    // These two change the page HTML in the browser only (formula text / rows the page receives)
    test.describe('with the page data changed in the browser', () => {
        test('the lines come from the rows, not from the formula text', async ({ request }) => {
            const formula = await pick(request, twoOperations);
            test.skip(!formula, `no formula with 5 rows for brand ${BRAND_ID}`);

            // Change the text the page receives (browser only); the rows are untouched
            await fp.gotoFormula(formula!.id, (html) =>
                html.replace(/"formula":"(?:[^"\\]|\\.)*"/, '"formula":"MSRP | - | 999"'),
            );

            expect(await fp.shownLines()).toEqual(linesFromRows(formula!.formula_price_margins));
            await expect(fp.preview()).not.toContainText('999');
        });

        test('a formula without rows starts empty (no text fallback, no pop-up)', async ({ request }) => {
            const formula = await pick(request, () => true);
            test.skip(!formula, `no formula for brand ${BRAND_ID}`);

            await fp.gotoFormula(formula!.id, (html) =>
                html.replace(/"formula_price_margins":\[[^\]]*\]/, '"formula_price_margins":[]'),
            );

            await expect(fp.lines()).toHaveCount(0);
            await expect(fp.page.locator('#formula_lines_empty')).toBeVisible();
            await expect(fp.page.locator('#toast-container .toast')).toHaveCount(0);
        });
    });

    test('SAVE without changes posts the same rows and the text with numbers as saved', async ({ request }) => {
        const formula = await pick(request, twoOperations);
        test.skip(!formula, `no formula with 5 rows for brand ${BRAND_ID}`);

        await fp.gotoFormula(formula!.id);
        const posted = await fp.save();

        expect(posted).toEqual({
            formula: expectedLabel(formula!.formula).split(' ').join(' | '), // e.g. ".5" posts as "0.5"
            rows: postedRows(formula!.formula_price_margins),
        });
        await expect(fp.page.locator('#id')).toHaveValue(String(formula!.id));
    });

    test('changing an operation, a number and adding parentheses changes what SAVE posts', async ({ request }) => {
        const formula = await pick(request, twoOperations);
        test.skip(!formula, `no formula with 5 rows for brand ${BRAND_ID}`);

        await fp.gotoFormula(formula!.id);
        const before = linesFromRows(formula!.formula_price_margins);
        expect(before.length, 'three lines').toBe(3);

        await fp.setOperation(2, '+');
        await fp.line(2).locator('input.line-value').fill('7');
        await fp.toggleOpen(1);
        await fp.toggleClose(2);
        const posted = await fp.save();

        const rows = postedRows(formula!.formula_price_margins);
        expect(posted!.rows).toEqual([
            rows[0],
            rows[1],
            { parentheses: '(' },
            rows[2],
            { operator: '+' },
            { variable: '7' },
            { parentheses: ')' },
        ]);
        const parts = expectedLabel(formula!.formula).split(' ');
        expect(posted!.formula).toBe([parts[0], parts[1], '(', parts[2], '+', '7', ')'].join(' | '));
    });

    test('SAVE is stopped with a message when every line is removed', async ({ request }) => {
        const formula = await pick(request, () => true);
        test.skip(!formula, `no formula for brand ${BRAND_ID}`);

        await fp.gotoFormula(formula!.id);
        while ((await fp.lines().count()) > 0) {
            await fp.remove(0);
        }
        const posted = await fp.save();

        expect(posted, 'nothing posted').toBeNull();
        await expect(fp.lastToast()).toContainText('Invalid Formula');
        await expect(fp.lastToast()).toContainText('Add at least one line');
    });

    test('SAVE is stopped with a message when a number is not a number', async ({ request }) => {
        const formula = await pick(request, (f) => f.formula_price_margins.some((row) => row.variable != null));
        test.skip(!formula, `no formula with a number for brand ${BRAND_ID}`);

        await fp.gotoFormula(formula!.id);
        const index = (await fp.shownLines()).findIndex((line) => line.type === 'number');
        await fp.line(index).locator('input.line-value').fill('abc');
        const posted = await fp.save();

        expect(posted, 'nothing posted').toBeNull();
        await expect(fp.lastToast()).toContainText(`Enter a number on line ${index + 1}`);
    });
});
