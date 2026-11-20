import { defineCreatePageTests } from './helpers/createPageTests';
import { LEGACY_PRICE_ITEM_CREATE_PAGE } from './helpers/priceItemCreatePage';

/**
 * Legacy price item create page (/admin/price_item/add_legacy): formula dropdown and price calculation from
 * formula_price_margins. It has the same controls and formula code as the price item create page, so the test
 * cases are shared; see helpers/createPageTests.ts. Add legacy-only cases below.
 */
defineCreatePageTests(LEGACY_PRICE_ITEM_CREATE_PAGE);
