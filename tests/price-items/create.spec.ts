import { defineCreatePageTests } from './helpers/createPageTests';
import { PRICE_ITEM_CREATE_PAGE } from './helpers/priceItemCreatePage';

/**
 * Price item create page (/admin/price_items/add): formula dropdown and price calculation from
 * formula_price_margins. The test cases are shared with the legacy page; see helpers/createPageTests.ts.
 */
defineCreatePageTests(PRICE_ITEM_CREATE_PAGE);
