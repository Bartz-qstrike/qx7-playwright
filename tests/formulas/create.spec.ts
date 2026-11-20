import { test, expect } from '../fixtures';
import { FormulaCreatePage } from './helpers/formulaCreatePage';

/**
 * Formula create page (/admin/formula/add): the line builder.
 * Checks the lines, the preview, validation, and what SAVE posts: the formula text (`formula`, tokens joined with
 * " | ", numbers as typed, parentheses as their own tokens) and one formula_price_margins row per token.
 * Nothing is saved: the submit is cancelled in the page and the store URL is blocked.
 */
test.describe('Formula create page: line builder', () => {
    let fp: FormulaCreatePage;

    test.beforeEach(async ({ page }) => {
        fp = new FormulaCreatePage(page);
        await fp.goto();
    });

    test.afterEach(async () => {
        fp.expectNoPageErrors();
    });

    test('starts empty', async () => {
        await expect(fp.lines()).toHaveCount(0);
        await expect(fp.page.locator('#formula_lines_empty')).toBeVisible();
        await expect(fp.preview()).toHaveText('(nothing added yet)');
    });

    test('first line shows "Start", later lines get an operation; preview keeps numbers as typed', async () => {
        await fp.addPriceMargin('Brand Cost (BC)');
        await fp.addNumber('.90');

        await expect(fp.line(0).locator('.fl-start')).toHaveText('Start');
        await expect(fp.line(0).locator('select.line-op')).toHaveCount(0);
        await expect(fp.line(0).locator('.fl-badge')).toHaveText(/price margin/i);
        await expect(fp.line(1).locator('select.line-op')).toHaveValue('*');
        await expect(fp.line(1).locator('.fl-badge')).toHaveText(/number/i);
        await expect(fp.page.locator('#formula_lines_empty')).toBeHidden();
        await expect(fp.preview()).toHaveText('Brand Cost (BC) * .90');
    });

    test('SAVE posts the old text format and one row per token', async () => {
        await fp.addPriceMargin('Brand Cost (BC)');
        await fp.addNumber('.90');
        const bc = await fp.priceMarginId('Brand Cost (BC)');

        const posted = await fp.save();

        expect(posted).toEqual({
            formula: 'Brand Cost (BC) | * | .90', // same text the old page saved
            rows: [{ price_margin_id: bc }, { operator: '*' }, { variable: '.90' }],
        });
    });

    test('parentheses are their own tokens in the preview, the text and the rows', async () => {
        await fp.addPriceMargin('Factory Cost (FC)');
        await fp.addPriceMargin('MSRP');
        await fp.toggleOpen(1);
        await fp.addNumber('2');
        await fp.setOperation(2, '+');
        await fp.toggleClose(2);

        await expect(fp.line(1).locator('.line-open')).toHaveClass(/active/);
        await expect(fp.preview()).toHaveText('Factory Cost (FC) * ( MSRP + 2 )');

        const fc = await fp.priceMarginId('Factory Cost (FC)');
        const msrp = await fp.priceMarginId('MSRP');
        const posted = await fp.save();

        expect(posted).toEqual({
            formula: 'Factory Cost (FC) | * | ( | MSRP | + | 2 | )',
            rows: [
                { price_margin_id: fc },
                { operator: '*' },
                { parentheses: '(' },
                { price_margin_id: msrp },
                { operator: '+' },
                { variable: '2' },
                { parentheses: ')' },
            ],
        });
    });

    test('toggling a parenthesis twice removes it again', async () => {
        await fp.addPriceMargin('MSRP');
        await fp.toggleOpen(0);
        await expect(fp.preview()).toHaveText('( MSRP');
        await fp.toggleOpen(0);
        await expect(fp.line(0).locator('.line-open')).not.toHaveClass(/active/);
        await expect(fp.preview()).toHaveText('MSRP');
    });

    test('removing the first line makes the next one "Start" and drops its operation', async () => {
        await fp.addNumber('2');
        await fp.addPriceMargin('MSRP');
        await fp.setOperation(1, '+');
        await expect(fp.preview()).toHaveText('2 + MSRP');

        await fp.remove(0);

        await expect(fp.lines()).toHaveCount(1);
        await expect(fp.line(0).locator('.fl-start')).toHaveText('Start');
        await expect(fp.preview()).toHaveText('MSRP');
    });

    const invalid: { name: string; build: (fp: FormulaCreatePage) => Promise<void>; message: string }[] = [
        { name: 'no lines', build: async () => {}, message: 'Add at least one line' },
        { name: 'no price margin', build: async (p) => { await p.addNumber('2'); }, message: 'Add at least one price margin' },
        {
            name: 'a price margin line with nothing chosen',
            build: async (p) => { await p.page.locator('#add_price_margin_line').click(); },
            message: 'Choose a price margin on line 1',
        },
        {
            name: 'an empty number',
            build: async (p) => { await p.addPriceMargin('MSRP'); await p.addNumber(''); },
            message: 'Enter a number on line 2',
        },
        {
            name: 'a number that is not a number',
            build: async (p) => { await p.addPriceMargin('MSRP'); await p.addNumber('abc'); },
            message: 'Enter a number on line 2',
        },
        {
            name: 'unbalanced parentheses',
            build: async (p) => { await p.addPriceMargin('MSRP'); await p.toggleOpen(0); await p.addNumber('2'); },
            message: 'Unbalanced parentheses',
        },
    ];

    for (const c of invalid) {
        test(`SAVE is stopped with a message: ${c.name}`, async () => {
            await c.build(fp);
            const posted = await fp.save();

            expect(posted, 'nothing posted').toBeNull();
            await expect(fp.lastToast()).toContainText('Invalid Formula');
            await expect(fp.lastToast()).toContainText(c.message);
        });
    }
});
