# qx7-playwright

End-to-end Playwright tests for the QX7 admin, kept outside the QX7 repo. They run against a **local** QX7 site
(`http://qx7.test` by default) and never save anything: no Save/Submit buttons are clicked. The two exceptions are
`tests/e2e/formula-flow.spec.ts`, which really saves its own records (see "End-to-end formula flow" below), and
`tests/price-margins/save-flow.spec.ts`, which saves one price margin and deletes it again (see "Price margin pages").

## Setup

New machine? Follow [INSTALL.md](INSTALL.md) for the full step-by-step setup.

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Fill in `.env` with a local admin account:

```
QX7_BASE_URL=http://qx7.test
QX7_EMAIL=...
QX7_PASSWORD=...
```

## Run

```bash
npx playwright test            # all tests
npx playwright test --headed   # watch the browser
npx playwright show-report     # open the HTML report of the last run
```

The `setup` project signs in once and stores the session in `.auth/admin.json` (git-ignored).

Check sign-in on its own: `npm run test:login` (`npm run test:login:headed` to watch the browser).

Run the programmatic updates headless: `npm run test:programmatic`. `brand-block-fabric-color-resave.spec.ts` logs in once, then
for every Brand Block link in the CSV named by `QX7_SRE_3215_CSV`: opens the Fabric Color modal, saves it, saves the Brand
Block, and moves to the next link. Blocks whose modal has no fabric colors are not saved. Each block's result is written to
`programmatic-results/sre-3215-resave-<timestamp>.csv` as it goes. `QX7_BLOCK_LIMIT=5` does only 5 rows;
`QX7_BLOCK_FROM_ID=<id>` starts at that block and `QX7_BLOCK_TO_ID=<id>` stops after it (to resume or redo a range). This writes to the local QX7 database.

Run one area only by passing its folder:

```bash
npx playwright test tests/add-ons
```

## Layout

```
tests/
  fixtures.ts            shared `test`/`expect` with automatic error screenshots (import from here)
  auth.setup.ts          shared sign-in, runs before every area
  helpers/               helpers shared by several areas
    formulas.ts          formula API calls + the OLD string-split calculation used for expected values
    login.ts             login(page): signs in with QX7_EMAIL / QX7_PASSWORD from .env
  programmatic-updates/  automations that log in, then update data on a page (URLs in .env)
  add-ons/               one folder per QX7 area
    create.spec.ts
    edit.spec.ts
    helpers/             helpers used only by this area
  formulas/
    create.spec.ts         /admin/formula/add (formula line builder)
    edit.spec.ts           /admin/formula/edit/{id} (same builder, loaded from formula_price_margins)
    helpers/formulaCreatePage.ts  builder helpers shared by both pages
    helpers/formulaEditPage.ts
  e2e/
    formula-flow.spec.ts   formula -> add-on -> price items, created, edited, bulk updated; SAVES
  price-margins/
    pages.spec.ts          /admin/price_margins, /admin/price_margin/add, /admin/price_margin/edit/{id}: sort order (no saving)
    save-flow.spec.ts      add, edit and delete one price margin with a sort order; SAVES, then deletes it
    helpers/priceMarginPages.ts
  price-items/
    index.spec.ts          /admin/price_items (index datatable, TYPE column)
    create.spec.ts         /admin/price_items/add
    create-sort-order.spec.ts  /admin/price_items/add, pricing table ordered by price margin sort_order
    legacy-create-sort-order.spec.ts  /admin/price_item/add_legacy, same sort order cases
    edit-sort-order.spec.ts  /admin/price_item/edit/{id} (non-legacy item), saved and added rows ordered by sort_order
    legacy-edit-sort-order.spec.ts  /admin/price_item/edit/{id} (Legacy item), same sort order cases
    index-sort-order.spec.ts  /admin/price_items, PRICING column lines ordered by sort_order
    legacy-create.spec.ts  /admin/price_item/add_legacy
    edit.spec.ts           /admin/price_item/edit/{id}, non-legacy item
    legacy-edit.spec.ts    /admin/price_item/edit/{id}, Legacy item (legacy edit page)
    helpers/
      createPageTests.ts   test cases shared by both create pages (defineCreatePageTests)
      editPageTests.ts     test cases shared by both edit pages (defineEditPageTests)
      priceItemCreatePage.ts
      priceItemEditPage.ts edit page helpers + finding suitable price items in the local data
      bulkUpdatePage.ts    bulk update page helpers (used by tests/e2e only; Adjust saves)
```

To add another area, create `tests/<area>/` with its own `*.spec.ts` files and `helpers/`, and import
`test`/`expect` from `tests/fixtures.ts` (not from `@playwright/test`) so error screenshots apply.
Move a helper up to a shared `tests/helpers/` folder only once a second area needs it.

## Error screenshots

Every test that imports from `tests/fixtures.ts` takes a full-page screenshot the moment the page hits an error,
and attaches it with a `.txt` of the details:

| Name | When |
|---|---|
| `error-NN-page-error` | uncaught JavaScript exception |
| `error-NN-console-error` | `console.error(...)` |
| `error-NN-http-<status>` | a response with status 400 or higher |
| `error-NN-request-failed` | a request that got no response |
| `error-NN-error-toast` | a red toastr error shown to the user |

They don't fail the test by themselves (some tests expect an error toast). Find them in
`test-results/<test>/` or in the HTML report (`npx playwright show-report`). A screenshot of the final state is
still taken whenever a test fails.

## Tests

### Add-ons pages (`tests/add-ons`, `formula_price_margins`)
The add-ons create/edit pages compute prices from each formula's `formula_price_margins` rows.
Expected results are computed with the **old** logic (splitting the formula string on `|`), so each check means
"the new page gives the same result as the old one".

- `tests/add-ons/create.spec.ts`: formula dropdown contents and labels, fixed amount computation from Factory Cost
  and from another price margin, recomputing on change, empty-value error, and a synthetic formula with two price
  margins (injected into the page, since none exists in the data yet).
- `tests/add-ons/edit.spec.ts`: on an existing local add-on, the saved formula is still pre-selected, the dropdown
  matches the old rule, and toggling recomputes the same value.
- A formula with parentheses (`formula_price_margins` rows with `parentheses`, injected into `/api/formulas`): on the
  create page `FC * ( <other> + 2 )`, on the edit page `<base> * ( <base> + 2 )`; checks the label and that the
  fixed amount is computed with the brackets.
- The pricing grid test is marked `fixme`: the Pricing Grid type is disabled on the page for maintenance.

### Price items index page (`tests/price-items/index.spec.ts`, TYPE column)
Page: `/admin/price_items`. The datatable is server-side; sorting sends the column index, which
`MasterPriceItemsDAO::getMasterPriceItemsPaginate` maps through `$staticTableColumns` (9 = type, 10 = active).
The tests check:
- the TYPE header sits between PRICING and ACTIVE, and every row has one cell per header;
- each row's TYPE cell matches the price item's `type` from `/api/price_items_paginate` (blank when null);
- the Types filter (BA, Legacy) only returns and shows rows of that type (skipped when the local data has none);
- clicking TYPE sorts by `order[0][column]=9`, ascending then descending;
- clicking ACTIVE sorts by `order[0][column]=10` and still succeeds after the column moved.

Nothing is saved: no toggle, duplicate, delete or export is clicked.

### Price item create pages (`tests/price-items`, `formula_price_margins`)
Pages: `/admin/price_items/add` (`create.spec.ts`) and the legacy `/admin/price_item/add_legacy`
(`legacy-create.spec.ts`), first fabric row. Both pages have the same controls and formula code, so both spec files
call the shared `defineCreatePageTests()` in `helpers/createPageTests.ts`; add page-only cases in that page's spec
file. Run one page with e.g. `npx playwright test tests/price-items/legacy-create.spec.ts`.
The tests pick a brand and sport from the local data, then check:
- the formula dropdown lists the same formulas as before, with the formula **id** as the value, the formula text in
  `data-formula-name` and the same label;
- turning QC on computes every size like before, from Factory Cost or from another price margin's row;
- values recompute when a source size or the formula changes; an empty source size is left alone;
- deleting a price margin is blocked while a QC-on formula uses it, and otherwise removes its formulas;
- the `properties` JSON that would be saved keeps `formula` (text) and adds `formula_id`;
- a synthetic formula with two price margins (injected into the `/api/formulas` response).

Nothing is saved: the store URL is blocked, and the save check is done by clicking create with the item name
empty, which builds `properties` and then stops at the required-field check.

### Price item create pages: pricing table order (`create-sort-order.spec.ts`, `legacy-create-sort-order.spec.ts`)
Pages: `/admin/price_items/add` (`tests/price-items/create-sort-order.spec.ts`) and the legacy
`/admin/price_item/add_legacy` (`tests/price-items/legacy-create-sort-order.spec.ts`), first fabric row. The two spec
files are separate copies with the same cases; only the page differs. Added price margins go into the pricing table by
`price_margins.sort_order`: Factory Cost stays the first row, then margins with a sort order ascending (ties by id),
then margins without one, by id. The sort orders come from `GET /api/price_margin/{id}`, which the tests rewrite in the
browser, so they don't depend on the local data. Factory Cost always gets sort order 999, to show it isn't sorted.
The tests check:
- ascending order whatever order the margins are added in, including a margin added later between two others;
- a sort order of 0 counts as a sort order;
- margins without a sort order go to the bottom, by id; equal sort orders go by id;
- Factory Cost stays first;
- with no `sort_order` field in the response (before the migration), added rows are ordered by id;
- rebuilding the size columns keeps each row's own inputs (`<size>-<price margin id>`), values and delete button
  (this fails if the rows are matched to `pm_arr` by insertion order);
- the `properties` that would be saved follow the table order.

Nothing is saved: the store URL is blocked and the item name is left empty.

### Price item edit pages: pricing table order (`edit-sort-order.spec.ts`, `legacy-edit-sort-order.spec.ts`)
Page: `/admin/price_item/edit/{id}` for a non-legacy item (`tests/price-items/edit-sort-order.spec.ts`) and for a Legacy
item (`legacy-price-items/edit.blade.php`, `tests/price-items/legacy-edit-sort-order.spec.ts`), first fabric row. The two
spec files are standalone copies with the same cases; they differ only in which kind of item they pick. It uses the same rules as the create pages, and the
**saved rows are also sorted when the page loads**, so the next save stores that order. Saved rows take their sort order
from `window.price_margins` (inline script); an added margin takes it from `GET /api/price_margin/{id}`. The tests rewrite
both in the browser (an `addInitScript` setter, like `overridePivotFormula`), and Factory Cost always gets 999.
The item is picked from the local data (read-only): a non-legacy (or Legacy) item whose first fabric starts with Factory Cost and has at
least 2 more saved price margins. The tests check:
- on load, saved rows follow the sort order (FC first), with unsorted rows at the bottom by id;
- with no `sort_order` field, saved rows are ordered by id;
- an added margin goes into its sorted place among the saved rows, and one without a sort order goes to the bottom;
- rebuilding the size columns keeps each row's own inputs, values and delete button (fails if the rows are matched to
  `pm_arr` by saved order);
- the `properties` that would be saved follow the table order.

Nothing is saved: the update URLs are blocked and the save check empties the item name first.

### Price items index page: PRICING column order (`tests/price-items/index-sort-order.spec.ts`, `sort_order`)
Page: `/admin/price_items`. Each PRICING block (one per fabric) lists its price margins with the same rules as the
create and edit pages: the first saved line (Factory Cost) stays first, then sort order ascending, then lines without a
sort order by id. Only the display changes; the saved `properties` keep their order. Sort orders come from
`window.price_margins`, which the tests rewrite in the browser (Factory Cost always gets 999). Expected orders come from
the `/api/price_items_paginate` response, and the page's lines are read by their `data-pm-id`. The tests use the rows
of the first page that have a fabric with 3 or more lines, and check:
- an item's lines follow the sort order (here: the reverse of its saved order), and so do the other rows;
- lines without a sort order go to the bottom, by id;
- with no `sort_order` field, lines are ordered by id;
- each line keeps its own size values;
- each row still has one pricing block per primary fabric.

Read only. Note: `index.spec.ts` (TYPE column) also fails on this branch without these changes, because the page has no
TYPE column here.

### Price margin pages (`tests/price-margins`, `sort_order`)
Pages: index `/admin/price_margins` (Name, Sort Order, actions), add `/admin/price_margin/add`
(`#price_margin_sort_order`) and edit `/admin/price_margin/edit/{id}` (`#sort_order`). Expected values come from the
public `GET /api/price_margins`.

`pages.spec.ts` saves nothing: `/admin/price_margin/store` and `/admin/price_margin/update` are aborted and the posted
form fields checked. It checks:
- the Sort Order header sits right after Name, and each row's cell equals the API `sort_order` (blank for null);
- the add and edit fields are number inputs (`name="sort_order"`, `min="0"`, `step="1"`) that refuse letters;
- add starts empty; SAVE posts the name and the sort order, or an empty sort order when left blank;
- edit is prefilled with the saved value (skipped when no local margin has one) or empty, and SAVE posts id, name and
  sort order.

`save-flow.spec.ts` **saves**. It runs in order, on one margin named `Playwright PM <YYYY-MM-DD HH:mm:ss>`:
1. add it with sort order 7; check the index and the API;
2. edit: prefilled 7, change to 3;
3. edit: clear the field; the index cell is blank and the API returns `null`;
4. delete it from the index.

The name is never changed, because renaming a margin starts jobs that rewrite price items, add-ons and formulas. If a
step fails, `afterAll` deletes the margin through `POST /api/price_margin/delete` with the signed-in admin's token.
Deletes are soft deletes, so each run leaves one trashed row in `price_margins`.

```bash
npx playwright test tests/price-margins
```

### Price item edit pages (`tests/price-items`, pivot table + `formula_price_margins`)
Pages: `/admin/price_item/edit/{id}` for a non-legacy item (`edit.spec.ts`) and for a Legacy item, which the
controller shows with the legacy edit page (`legacy-edit.spec.ts`). Both pages have the same formula code, so both spec
files call the shared `defineEditPageTests()` in `helpers/editPageTests.ts`; add page-only cases in that page's spec
file. Run one page with e.g. `npx playwright test tests/price-items/legacy-edit.spec.ts`.

Each saved row's starting formula comes from `master_price_item_fabric_margins.formula_id` (sent in
`window.price_item.fabric_margins`), falling back to the saved `formula` text when the pivot has none. A row saved
without a fabric code (legacy items) matches the pivot row with no fabric. The tests search the newest price items of
the page's kind (read-only API calls) for one with pivot formulas, one without pivot rows and one with a QC-on row,
then check:
- each saved row starts with the pivot's `formula_id`; options use the id as value and the text in `data-formula-name`;
- without pivot rows, the formula matching the saved text is preselected (as before);
- the pivot wins over a different saved text, and a null pivot `formula_id` falls back to the text (both by changing
  the pivot data the page receives, in the browser only);
- size prices still show the saved `properties` values;
- turning QC on, or changing the formula, recomputes like the old string-split logic;
- the `properties` that would be saved have `formula` (text) and `formula_id` of the selected formula;
- a formula with parentheses, `<base> * ( <base> + 2 )` (injected into `/api/formulas`), recomputes a QC-on row
  with the brackets.

Nothing is saved: the update URLs are blocked, and the save check empties the item name before clicking SAVE.

### Formula create page (`tests/formulas/create.spec.ts`, line builder)
The formula is built one line at a time ("Start" then an operation per line, optional `(` `)`, a price margin or a
number). SAVE posts the formula text (`formula`: tokens joined with ` | `, numbers as typed, parentheses as their own
tokens) and `formula_price_margins` (one row per token: `price_margin_id`, `operator`, `parentheses` or `variable`).
The tests check:
- the empty state, "Start" on the first line and an operation on later lines, and the badges;
- the preview, e.g. "Brand Cost (BC) * .90" and "Factory Cost (FC) * ( MSRP + 2 )", including toggling a
  parenthesis off again;
- removing the first line makes the next one "Start";
- what SAVE posts: `Brand Cost (BC) | * | .90` (same text as the old page) and the rows, including parenthesis rows;
- each validation message ("Invalid Formula" toast), with nothing posted.

Nothing is saved: the form's submit is cancelled in the page and the store URL is blocked.

### Formula edit page (`tests/formulas/edit.spec.ts`, line builder from `formula_price_margins`)
The edit page uses the same builder (markup partial + `public/js/formulas/formula-builder.js`). Its lines come from the formula's `formula_price_margins`
rows (sent with `/api/formula/{id}`), not from the formula text; SAVE posts the text and the rows, which the update
replaces. Formulas are picked from `/api/formulas/3`. The tests check:
- the lines, preview, name and brands of a saved formula, including one with parentheses;
- the lines ignore the text, and a formula without rows starts empty with no pop-up (both by changing the page HTML in
  the browser only; this file starts Chrome with its local-network checks off so the rewritten page can load
  `/js` and `/css`);
- SAVE unchanged posts the same rows (numbers as saved, e.g. `.5` becomes `0.5`); edits and added parentheses change
  what is posted;
- the validation toasts.

Nothing is saved: the form's submit is cancelled in the page and the update URL is blocked.

The price item create tests also include a formula with parentheses (injected into `/api/formulas`), which checks
the pages compute `FC * (<other> + 2)`.

Brands, formulas and add-ons are picked from the local API at runtime; tests skip with a message if the local data
has nothing suitable.

### End-to-end formula flow (`tests/e2e/formula-flow.spec.ts`, SAVES)
The only spec that saves. It runs its tests in order (serial) and leaves everything in the local DB so the records can
be checked by hand. Each record is named `Playwright E2E <YYYY-MM-DD HH:mm:ss>` (the run prints the name and the
divisor):
1. **Formula** (`/admin/formula/add`): `Brand Cost (BC) * ( MSRP + 2 ) / <divisor>`. Factory Cost is not used. The
   divisor changes per run so the formula text is unique. It is saved for one brand that has a spec sheet with sizes
   and is offered on the add-ons page. The test checks the saved text, the 9 `formula_price_margins` rows (parentheses
   on their own rows) and the edit page's lines (the edit page itself is not saved).
2. **Add-on** (`/admin/master_add_on/add`, fixed amount): FC 10, BC 100, MSRP 20, and a fourth price margin that uses
   the formula (toggle on). Saved; `pricing_details` hold `formula_id` and the computed price.
3. and 4. **Price item** and **legacy price item** (`/admin/price_items/add`, `/admin/price_item/add_legacy`): the
   brand's first spec sheet with sizes; FC, BC and MSRP sizes; a fourth price margin with the formula and QC on. Saved;
   `properties` hold the computed sizes, `formula_id` and the formula text.
5. **Add-on edit**: the formula is preselected; BC 40 and MSRP 6 give the new value; saved again.
6. and 7. **Price item edit pages** (the two items above): the formula is preselected; new BC and MSRP sizes
   recompute the formula row; saved again.
8. **Bulk update** (`/admin/price_items/bulk_update`). The page only adjusts a price margin whose own row has QC on
   (the "Formula Dependent" table), so the test first turns Brand Cost's QC on in both items, using the first Factory
   Cost formula that gives non-zero prices, and saves. It then waits for the queue to sync the pivot table, and bulk
   updates Brand Cost +10% on both items. Checks:
   - BC sizes are +10%, and BC's QC is turned off;
   - the formula row equals `new BC * ( MSRP + 2 ) / <divisor>` per size. This is computed on the server from the
     formula's `formula_price_margins` rows, with MSRP taken from the pivot `size_prices`.

   This step needs the queue worker running, because the bulk update reads MSRP from the pivot table.

FC, BC and MSRP are required by the add-on and price item saves, so they are always filled. Each run leaves one
formula, one add-on and two price items (named `... price item` and `... legacy price item`); search the admin lists
for `Playwright E2E` to find them, and delete them by hand when no longer needed.

```bash
npx playwright test tests/e2e
```
