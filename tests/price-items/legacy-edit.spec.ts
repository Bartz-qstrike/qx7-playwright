import { defineEditPageTests } from './helpers/editPageTests';
import { LEGACY_PRICE_ITEM_EDIT_PAGE } from './helpers/priceItemEditPage';

/**
 * Legacy price item edit page (/admin/price_item/edit/{id} for a Legacy item): formula from the pivot table, prices
 * from formula_price_margins. Legacy items are saved without a fabric code, so their rows match the pivot rows that
 * have no fabric. Same formula code as the price item edit page, so the test cases are shared; see
 * helpers/editPageTests.ts. Add legacy-only cases below.
 */
defineEditPageTests(LEGACY_PRICE_ITEM_EDIT_PAGE);
