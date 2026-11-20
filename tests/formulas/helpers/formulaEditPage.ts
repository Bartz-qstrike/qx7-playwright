import { APIRequestContext, expect } from '@playwright/test';
import { Formula, FormulaRow } from '../../helpers/formulas';
import { FormulaCreatePage } from './formulaCreatePage';

/** One builder line as the edit page should show it. */
export interface ExpectedLine {
    op: string | null; // null on the first line ("Start")
    open: boolean;
    close: boolean;
    type: 'price_margin' | 'number';
    value: string; // price margin id, or the number as JS prints it
}

/** Expected builder lines from a formula's formula_price_margins rows (same walk as the page's rowsToLines). */
export function linesFromRows(rows: FormulaRow[]): ExpectedLine[] {
    const lines: ExpectedLine[] = [];
    let op: string | null = null;
    let open = false;
    for (const row of [...rows].sort((a, b) => a.index_in_formula - b.index_in_formula)) {
        if (row.price_margin_id != null || row.variable != null) {
            lines.push({
                op: lines.length ? op : null,
                open,
                close: false,
                type: row.price_margin_id != null ? 'price_margin' : 'number',
                value: String(row.price_margin_id != null ? row.price_margin_id : Number(row.variable)),
            });
            open = false;
        } else if (row.parentheses === '(') {
            open = true;
        } else if (row.parentheses === ')') {
            lines[lines.length - 1].close = true;
        } else if (row.operator != null) {
            op = row.operator;
        }
    }
    return lines;
}

export async function getFormula(request: APIRequestContext, id: number): Promise<Formula> {
    const response = await request.get(`/api/formula/${id}`);
    expect(response.ok(), `GET /api/formula/${id}`).toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);
    return body.formula;
}

/**
 * Chrome flags for tests that rewrite the page HTML (gotoFormula with `rewrite`): a page served by the test counts as
 * a public page, so Chrome's local-network checks would block its /js and /css files from qx7.test.
 * Use with `test.use({ launchOptions: { args: REWRITE_HTML_CHROME_ARGS } })`.
 */
export const REWRITE_HTML_CHROME_ARGS = [
    '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks',
];

/**
 * Formula edit page (/admin/formula/edit/{id}): the same line builder, with lines loaded from the formula's
 * formula_price_margins rows. The update URL is blocked and the submit is captured (nothing is saved).
 */
export class FormulaEditPage extends FormulaCreatePage {
    /**
     * Opens the edit page. `rewrite` changes the page HTML in the browser only, e.g. to change the formula text or
     * the rows the page receives in `@json($formula)`.
     */
    async gotoFormula(id: number, rewrite?: (html: string) => string) {
        if (rewrite) {
            await this.page.route(`**/admin/formula/edit/${id}`, async (route) => {
                const response = await route.fetch();
                // Drop the original length/encoding headers: the rewritten body has a different size
                const headers = { ...response.headers() };
                delete headers['content-length'];
                delete headers['content-encoding'];
                await route.fulfill({ response, headers, body: rewrite(await response.text()) });
            });
        }
        await this.open(`/admin/formula/edit/${id}`, '**/admin/formula/update');
    }

    /** What the builder currently shows, line by line. */
    async shownLines(): Promise<ExpectedLine[]> {
        return this.page.$$eval('#formula_lines .formula-line', (elements) =>
            elements.map((element, i) => {
                const op = element.querySelector('select.line-op') as HTMLSelectElement | null;
                const value = element.querySelector('.line-value') as HTMLInputElement | HTMLSelectElement;
                return {
                    op: i === 0 ? null : op ? op.value : '?',
                    open: element.querySelector('.line-open')!.classList.contains('active'),
                    close: element.querySelector('.line-close')!.classList.contains('active'),
                    type: value.tagName === 'SELECT' ? ('price_margin' as const) : ('number' as const),
                    value: value.value,
                };
            }),
        );
    }
}
