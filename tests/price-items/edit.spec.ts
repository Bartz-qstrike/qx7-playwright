import { defineEditPageTests } from './helpers/editPageTests';
import { PRICE_ITEM_EDIT_PAGE } from './helpers/priceItemEditPage';

/**
 * Price item edit page (/admin/price_item/edit/{id}, non-legacy items): formula from the pivot table, prices from
 * formula_price_margins. It has the same formula code as the legacy edit page, so the test cases are shared; see
 * helpers/editPageTests.ts. Add page-only cases below.
 */
defineEditPageTests(PRICE_ITEM_EDIT_PAGE);
