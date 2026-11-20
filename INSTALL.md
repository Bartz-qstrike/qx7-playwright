# Installing qx7-playwright

A step-by-step guide to set up and run the QX7 Playwright tests on a new machine. Follow the steps in order; each one
ends with a check so you know it worked before moving on. For what each test does, see [README.md](README.md).

> These tests run against a **local** QX7 site only. Never point them at production or use a production account.

---

## Prerequisites

You need these before you start:

| What | Why | How to check |
|---|---|---|
| **Git** | to get the code | `git --version` |
| **Node.js 22 (LTS)** and **npm** | runs Playwright and the tests (tested with Node 22.23 / npm 10.9) | `node -v` shows `v22.x`; `npm -v` shows `10.x` |
| **A local QX7 site** | the site the tests open | open `http://qx7.test` in your browser; the QX7 login page loads |
| **A local QX7 admin account** | the tests sign in with it | you can sign in at `http://qx7.test/login` by hand |

If Node.js is missing, install the 22 LTS version from <https://nodejs.org> (or with a version manager such as `nvm`:
`nvm install 22`).

The end-to-end formula flow (`tests/e2e`) also needs the **QX7 queue worker** running on the local site, because its
bulk update step reads data written by queued jobs.

---

## Step 1: Get the code

Clone the repository (replace `<repo-url>` with this repository's URL) and go into the folder:

```bash
git clone <repo-url> qx7-playwright
```

```bash
cd qx7-playwright
```

**Check:** `ls` shows `package.json`, `playwright.config.ts` and a `tests` folder.

All the following commands are run from inside this `qx7-playwright` folder.

---

## Step 2: Install the dependencies

```bash
npm ci
```

This installs the exact versions in `package-lock.json` (Playwright 1.64.1, TypeScript, dotenv) into `node_modules/`.

**Check:** the command ends without `ERR!` lines, and a `node_modules` folder now exists.

---

## Step 3: Install the browser

Playwright drives its own copy of Chromium, which is downloaded separately:

```bash
npx playwright install chromium
```

On **Linux**, also install the system libraries Chromium needs:

```bash
npx playwright install --with-deps chromium
```

**Check:** the command finishes with Chromium downloaded (it prints the download progress, or nothing if it is already
installed).

---

## Step 4: Create your `.env` file

Copy the example file:

```bash
cp .env.example .env
```

(On Windows Command Prompt use `copy .env.example .env`.)

Open `.env` in a text editor and fill in at least the first three values:

| Variable | Required? | What to put |
|---|---|---|
| `QX7_BASE_URL` | yes | address of your local QX7 site; default `http://qx7.test` |
| `QX7_EMAIL` | yes | email of your **local** QX7 admin account |
| `QX7_PASSWORD` | yes | password of that account |
| `QX7_BRAND_BLOCK_INDEX` | only for the SRE-3215 resave | Brand Block index page; default `http://qx7.test/admin/brand/block_pattern_rules` |
| `QX7_SRE_3215_CSV` | only for the SRE-3215 resave | CSV of Brand Block links; default `SRE-3215 Audit - Affected Block.csv` (in this folder) |
| `QX7_BLOCK_LIMIT` | optional | only process the first N CSV rows; leave blank for all |
| `QX7_BLOCK_FROM_ID` | optional | start at this Brand Block ID (to resume a stopped run); blank = from the top |
| `QX7_BLOCK_TO_ID` | optional | stop after this Brand Block ID; blank = to the end |

`.env` is git-ignored, so your password is never committed.

**Check:** `.env` exists and `QX7_EMAIL` / `QX7_PASSWORD` are not empty.

---

## Step 5: Check the installation

First make sure the TypeScript compiles:

```bash
npm run typecheck
```

**Check:** it prints nothing after the command line and ends without errors.

Then check that the tests can sign in to your local site:

```bash
npm run test:login
```

**Check:** the output ends with `3 passed` (the shared sign-in plus the two login tests) and no `failed`. This also saves the signed-in session to
`.auth/admin.json`, which the other tests reuse.

To watch the browser while it signs in:

```bash
npm run test:login:headed
```

If both checks pass, the installation is complete.

---

## Step 6: Run the tests

Run all tests (headless, one at a time):

```bash
npm test
```

Watch the browser while they run:

```bash
npm run test:headed
```

Run one area only, by passing its folder (for example the add-ons tests):

```bash
npx playwright test tests/add-ons
```

Open the HTML report of the last run (with screenshots of any errors):

```bash
npm run report
```

### Tests that change data

Most tests only read and never click Save. These ones **write to the local QX7 database**:

| Tests | What they change |
|---|---|
| `tests/e2e` | create and leave one formula, one add-on and two price items named `Playwright E2E <date time>` |
| `tests/price-margins/save-flow.spec.ts` | add, edit and delete one price margin (leaves one soft-deleted row) |
| `tests/programmatic-updates` (`npm run test:programmatic`) | re-save every Brand Block listed in the SRE-3215 CSV; results go to `programmatic-results/` |

Note that `npm test` runs all of them. To avoid them, run single folders instead.

---

## Updating later

When the code changes, update and reinstall:

```bash
git pull
```

```bash
npm ci
```

```bash
npx playwright install chromium
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Set QX7_EMAIL and QX7_PASSWORD in .env ...` | `.env` is missing or those values are empty; redo Step 4 |
| `... rejected QX7_EMAIL / QX7_PASSWORD ... ("Invalid Email or Password")` | the account does not exist in the **local** QX7 database, or the password is wrong; check by signing in at `http://qx7.test/login` by hand |
| `net::ERR_NAME_NOT_RESOLVED` or `ERR_CONNECTION_REFUSED` | the local QX7 site is not running, or `QX7_BASE_URL` in `.env` is wrong; open the address in your browser to check |
| Sign-in fails with `expect(page).not.toHaveURL` and an `error-01-http-504` (or other 5xx) screenshot | the local QX7 site answered the login with a server error; check its PHP/web server and database are running (sign in by hand to confirm), then retry |
| `Executable doesn't exist at ...` | the Playwright browser is not installed; redo Step 3 |
| Tests suddenly land on the login page | the saved session expired; delete the `.auth` folder and run `npm run test:login` again |
| `node: command not found` / wrong Node version | install Node.js 22 LTS (see Prerequisites) |
| Tests skip with a message about local data | the local database has nothing suitable for that test (for example no matching brand or price item); this is expected |

When a test fails, its screenshots, error details and trace are in `test-results/<test name>/`, and in the HTML report
(`npm run report`).
