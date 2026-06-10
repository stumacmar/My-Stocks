const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const HTML_PATH = `file://${path.resolve(__dirname, '../index.html')}`;

// Sample FMP-style API response for a stock
const MOCK_PROFILE = [{ companyName: 'Apple Inc.', industry: 'Technology', price: 175.5, beta: 1.2 }];
const MOCK_INCOME  = [{ operatingIncome: 1e10 }];
const MOCK_BALANCE = [{ totalAssets: 5e10, totalCurrentLiabilities: 1e10 }];
const MOCK_CASHFLOW= [{ depreciationAndAmortization: 5e8 }];
const MOCK_PRICES  = Array.from({ length: 260 }, (_, i) => ({ close: 170 + i * 0.1 }));
const MOCK_RATIOS  = [{ priceEarningsToGrowthRatio: 1.2 }];

async function mockFMPApi(page) {
  await page.route('**/financialmodelingprep.com/stable/**', async route => {
    const url = route.request().url();
    let body;
    if      (url.includes('profile'))               body = MOCK_PROFILE;
    else if (url.includes('income-statement'))       body = MOCK_INCOME;
    else if (url.includes('balance-sheet'))          body = MOCK_BALANCE;
    else if (url.includes('cash-flow'))              body = MOCK_CASHFLOW;
    else if (url.includes('historical-price-eod'))   body = MOCK_PRICES;
    else if (url.includes('ratios'))                 body = MOCK_RATIOS;
    else                                             body = [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function mockFMPApiAllErrors(page, status = 401) {
  await page.route('**/financialmodelingprep.com/stable/**', async route => {
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ message: `HTTP ${status}` }) });
  });
}

test.describe('Stock Screener', () => {

  test.beforeEach(async ({ page }) => {
    // Skip first-run overlays (welcome splash + onboarding) which sit above the
    // UI and would intercept pointer events during tests.
    await page.addInitScript(() => {
      localStorage.setItem('compass_welcomed_v1', '1');
      localStorage.setItem('fmp_onboarded_v5', '1');
    });
  });

  test('page loads with correct title', async ({ page }) => {
    await page.goto(HTML_PATH);
    await expect(page).toHaveTitle(/Stuart's Stock Compass/);
    await expect(page.locator('.header-title')).toContainText("Stuart's Stock Compass");
  });

  test('first-run welcome splash appears for new users', async ({ page }) => {
    // Fresh context without the welcomed flag: splash must show
    await page.addInitScript(() => localStorage.removeItem('compass_welcomed_v1'));
    await page.goto(HTML_PATH);
    await expect(page.locator('#welcomeSplash')).toBeVisible();
    await page.locator('.splash-skip').click();
    await expect(page.locator('#welcomeSplash')).toBeHidden();
  });

  test('Run button is visible with estimated time', async ({ page }) => {
    await page.goto(HTML_PATH);
    const btn = page.locator('#btnRun');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText('Run Screener');
  });

  test('Pause and Stop buttons are hidden before run', async ({ page }) => {
    await page.goto(HTML_PATH);
    await expect(page.locator('#btnPause')).toBeHidden();
    await expect(page.locator('#btnStop')).toBeHidden();
  });

  test('screener shows "Starting…" then "Fetching" immediately after Run is clicked', async ({ page }) => {
    await page.goto(HTML_PATH);
    await mockFMPApi(page);

    // Intercept progress label changes
    await page.click('#btnRun');

    // Should quickly transition from Starting... to Fetching...
    await expect(page.locator('#progressLabel')).toContainText('Fetching', { timeout: 2000 });
  });

  test('screener progresses past Starting and loads at least one stock', async ({ page }) => {
    await page.goto(HTML_PATH);
    await mockFMPApi(page);

    await page.click('#btnRun');

    // Wait until at least one stock result appears in the table
    // The stat card should update from "—" to a number
    await expect(page.locator('#statShowing')).not.toHaveText('—', { timeout: 10000 });

    // Stop early to avoid processing 497 stocks
    await page.click('#btnStop');

    // Verify screener completes (stopped state)
    await expect(page.locator('#progressLabel')).toContainText('Stopped', { timeout: 5000 });
  });

  test('Run button is re-enabled after Stop', async ({ page }) => {
    await page.goto(HTML_PATH);
    await mockFMPApi(page);

    await page.click('#btnRun');
    await expect(page.locator('#progressLabel')).toContainText('Fetching', { timeout: 2000 });
    await page.click('#btnStop');

    // Run button must be re-enabled after stop (critical: prevents stuck state)
    await expect(page.locator('#btnRun')).not.toBeDisabled({ timeout: 5000 });
    await expect(page.locator('#btnPause')).toBeHidden({ timeout: 5000 });
    await expect(page.locator('#btnStop')).toBeHidden({ timeout: 5000 });
  });

  test('running=true is always cleared — cannot get stuck at Starting…', async ({ page }) => {
    await page.goto(HTML_PATH);
    await mockFMPApi(page);

    // Inject a deliberate error in updateStats (called during setup, before the main loop)
    // to simulate any unexpected exception in the pre-loop setup code
    await page.evaluate(() => {
      const orig = window.updateStats;
      window.updateStats = function() {
        window.updateStats = orig; // restore for subsequent calls
        throw new Error('Deliberate setup error to test recovery');
      };
    });

    await page.click('#btnRun');

    // Despite the setup error, the finally block must always reset running=false
    // and re-enable the Run button (previously this would leave it stuck forever)
    await expect(page.locator('#btnRun')).not.toBeDisabled({ timeout: 5000 });
    await expect(page.locator('#msgBanner')).toContainText('Screener failed', { timeout: 5000 });
  });

  test('screener handles all-API-failure gracefully (shows error, run button re-enabled)', async ({ page }) => {
    await page.goto(HTML_PATH);
    // Set up API to return 401 for every request
    await mockFMPApiAllErrors(page, 401);

    await page.click('#btnRun');

    // Should progress past Starting... quickly (failures are fast with 401)
    await expect(page.locator('#progressLabel')).toContainText('Fetching', { timeout: 2000 });

    // Stop early
    await page.click('#btnStop');

    // Run button should be re-enabled
    await expect(page.locator('#btnRun')).not.toBeDisabled({ timeout: 5000 });
  });

  test('API key missing shows error instead of running', async ({ page }) => {
    await page.goto(HTML_PATH);

    // Clear the API key
    await page.fill('#apiKey', '');
    await page.click('#btnRun');

    // Should show an error message, not start running
    await expect(page.locator('#msgBanner')).toContainText('API key', { timeout: 2000 });
    await expect(page.locator('#btnPause')).toBeHidden();
  });

  test('universe toggle switches between S&P 500 and Russell 1000', async ({ page }) => {
    await page.goto(HTML_PATH);

    const sp500Btn  = page.locator('#btnUnivSP500');
    const r1kBtn    = page.locator('#btnUnivR1K');

    await expect(sp500Btn).toHaveClass(/active/);
    await expect(r1kBtn).not.toHaveClass(/active/);

    await page.click('#btnUnivR1K');
    await expect(r1kBtn).toHaveClass(/active/);
    await expect(sp500Btn).not.toHaveClass(/active/);

    // S&P 500 has fewer tickers than Russell 1000
    const sp500Text = await sp500Btn.textContent();
    const r1kText   = await r1kBtn.textContent();
    const sp500Count = parseInt(sp500Text.match(/\d+/)[0], 10);
    const r1kCount   = parseInt(r1kText.match(/\d+/)[0], 10);
    expect(r1kCount).toBeGreaterThan(sp500Count);
  });

  test('filter buttons update the displayed results', async ({ page }) => {
    await page.goto(HTML_PATH);
    await mockFMPApi(page);

    await page.click('#btnRun');
    // Wait for at least one result
    await expect(page.locator('#statShowing')).not.toHaveText('—', { timeout: 10000 });
    await page.click('#btnStop');
    await expect(page.locator('#btnRun')).not.toBeDisabled({ timeout: 5000 });

    // Click "Strong" filter
    await page.locator('[data-filter="strong"]').click();
    const strongShowing = await page.locator('#statShowing').textContent();
    // Clicking All restores count
    await page.locator('[data-filter="all"]').click();
    const allShowing = await page.locator('#statShowing').textContent();
    // "All" should show >= strong
    expect(parseInt(allShowing) >= parseInt(strongShowing)).toBeTruthy();
  });
});
