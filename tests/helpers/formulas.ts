import { APIRequestContext, expect } from '@playwright/test';

export const FACTORY_COST_ID = 9;
export const FACTORY_COST_NAME = 'Factory Cost (FC)';

export interface FormulaRow {
    id?: number;
    formula_id?: number;
    index_in_formula: number;
    price_margin_id: number | null;
    operator: string | null;
    /** "(" or ")" on its own row (everything else null); absent on rows from before the column existed. */
    parentheses?: string | null;
    variable: number | string | null;
}

export interface Formula {
    id: number;
    name?: string | null;
    formula: string;
    brand_ids?: string | null;
    formula_price_margins: FormulaRow[];
}

export interface PriceMargin {
    id: number;
    name: string;
}

export interface AddOn {
    id: number;
    brand_id: number | string;
    type: string;
    pricing_details: string;
}

export interface FixedAmountDetail {
    price: string;
    price_margin_id: number;
    formula_id?: string | number | null;
    is_active?: number;
}

// ---------- API ----------

export async function getFormulas(request: APIRequestContext, brandId: string | number): Promise<Formula[]> {
    const response = await request.get(`/api/formulas/${brandId}`);
    expect(response.ok(), `GET /api/formulas/${brandId}`).toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);
    return body.formulas;
}

export async function getPriceMargins(request: APIRequestContext): Promise<PriceMargin[]> {
    const response = await request.get('/api/price_margins');
    expect(response.ok(), 'GET /api/price_margins').toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);
    return body.price_margins;
}

export async function getAddOns(request: APIRequestContext): Promise<AddOn[]> {
    const response = await request.get('/api/master_add_ons');
    expect(response.ok(), 'GET /api/master_add_ons').toBeTruthy();
    const body = await response.json();
    expect(body.success).toBe(true);
    return body.add_ons;
}

// ---------- The OLD page logic (string split on "|"), used to compute expected results ----------

export function legacyParts(formula: string): string[] {
    return formula.split('|').map((part) => part.trim());
}

/** Price margin name the old page read from the formula string (part 0). */
export function legacyPriceMarginName(formula: string): string {
    return legacyParts(formula)[0];
}

/** Old updateComputation / updatePriceComputation: start value + parts 1-2 (and 3-4), eval, round to 2 decimals. */
export function legacyCompute(formula: string, startValue: string): string {
    const frml = formula.split('|');
    const equation =
        frml.length == 5
            ? startValue + frml[1].trim() + frml[2].trim() + frml[3].trim() + frml[4].trim()
            : startValue + frml[1].trim() + frml[2].trim();

    return roundLikePage(evaluate(equation));
}

/** Old dropdown rule: a formula is listed when its price margin (part 0) is already on the page. */
export function legacyListedFormulaIds(formulas: Formula[], includedNames: string[]): number[] {
    return formulas
        .filter((formula) => includedNames.includes(legacyPriceMarginName(formula.formula)))
        .map((formula) => Number(formula.id))
        .sort((a, b) => a - b);
}

/** Option text the new page shows: the formula's parts with numbers normalised ('.5' -> '0.5'). */
export function expectedLabel(formula: string): string {
    return legacyParts(formula)
        .map((part) => (part !== '' && !isNaN(Number(part)) ? String(parseFloat(part)) : part))
        .join(' ');
}

// ---------- Math helpers matching the page ----------

export function evaluate(equation: string): number {
    // Same semantics as the page's eval(); equations only contain numbers and + - * / ( )
    return new Function(`return (${equation});`)() as number;
}

export function roundLikePage(value: number): string {
    return (Math.round(value * 100) / 100).toFixed(2);
}
