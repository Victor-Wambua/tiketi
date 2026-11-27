import { expect, test, type Page } from '@playwright/test';

const DEP = 'dep-last-matatu-1';

async function open(page: Page, hash = '') {
  await page.goto(`./${hash}`);
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function freeSeats(page: Page): Promise<string[]> {
  const states = await page.evaluate(async (dep) => {
    const r = await fetch(`/api/departures/${dep}/seats`);
    return ((await r.json()) as { states: Record<string, string> }).states;
  }, DEP);
  return Object.entries(states)
    .filter(([, s]) => s === 'available')
    .map(([id]) => id);
}

async function holdOneSeat(page: Page) {
  await open(page, `#/d/${DEP}`);
  await expect(page.locator('g.seat').first()).toBeVisible();
  const [seat] = await freeSeats(page);
  await page.locator(`g.seat[data-seat="${seat}"]`).click();
  await page.getByRole('button', { name: 'Hold seats' }).last().click();
  await expect(page.locator('.countdown')).toHaveText(/^(10:00|09:5\d)$/);
}

async function startPayment(page: Page) {
  await page.fill('#f-name', 'Test Buyer');
  await page.fill('#f-phone', '0700 000 001');
  await page.getByRole('button', { name: /Pay KES/ }).click();
}

test('starts with the banner, sample events and no request leaving the page', async ({ page, baseURL }) => {
  const outside: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(baseURL!) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) {
      outside.push(r.url());
    }
  });
  await open(page);
  await expect(page.getByText('Static demo. Runs in your browser on invented data')).toBeVisible();
  await expect(page.locator('.ticket-card')).toHaveCount(3);
  await page.getByRole('link', { name: 'How it works' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'How this demo works' })).toBeVisible();
  expect(outside).toEqual([]);
});

test('hold seats, pay with the mock M-Pesa, get a signed ticket', async ({ page }) => {
  await holdOneSeat(page);
  await startPayment(page);
  await page.locator('[data-outcome="success"]').click();
  await expect(page).toHaveURL(/#\/t\/tkt_/);
  const code = (await page.locator('.code-text').textContent())!.trim();
  expect(code).toMatch(/^TK1\.tkt_[0-9a-f]+\.dep-last-matatu-1\.[A-Z0-9]+\.1\.[A-Za-z0-9_-]{86}$/);
});

test('a cancelled payment does not sell the seat', async ({ page }) => {
  await holdOneSeat(page);
  await startPayment(page);
  await page.locator('[data-outcome="cancelled"]').click();
  await expect(page.getByText(/cancel/i).first()).toBeVisible();
  await expect(page).not.toHaveURL(/#\/t\//);
});

test('skipping ahead lets a hold expire and the seat goes back on sale', async ({ page }) => {
  await holdOneSeat(page);
  await page.getByRole('button', { name: 'Skip ahead 10 min' }).click();
  await expect(page.locator('.countdown')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText(/10 min ahead/)).toBeVisible();
});

test('two buyers, one seat: exactly one wins and SQLite refuses a second claim', async ({ page }) => {
  await open(page, '#/demo/race');
  await page.getByLabel('How many buyers').selectOption('6');
  await page.getByRole('button', { name: 'Start the race' }).click();
  const rows = page.locator('.race-table tbody tr');
  await expect(rows).toHaveCount(6);
  await expect(page.locator('.race-table .is-win')).toHaveCount(1);
  await expect(page.locator('.race-table .is-lose')).toHaveCount(5);
  await expect(page.getByText(/Exactly one of 6 requests won/)).toBeVisible();
  await page.getByRole('button', { name: 'Try to add a second claim by hand' }).click();
  await expect(page.getByText(/UNIQUE constraint failed: seat_claims/)).toBeVisible();
});

test('gate checks: valid passes; second scan, tampered and forged tickets are refused with reasons', async ({
  page,
}) => {
  await open(page, '#/demo/gate');
  const run = async (n: number) => {
    await page.locator('.cases button').nth(n).click();
    return page.locator('.cases tbody tr').nth(n).locator('.scan-result');
  };
  const valid = await run(0);
  await expect(valid).toContainText('Admitted');
  const again = await run(1);
  await expect(again).toContainText('Refused: already used');
  await expect(again).toContainText(/Already scanned at \d\d:\d\d at Gate A/);
  const tampered = await run(2);
  await expect(tampered).toContainText('Refused: not a genuine ticket');
  await expect(tampered).toContainText('signature does not match');
  const forged = await run(3);
  await expect(forged).toContainText('Refused: not a genuine ticket');
  await expect(forged).toContainText("signature does not match the organiser's key".replace("'", '’'));
});

test('staff sign-in runs scrypt in the page and opens the dashboard', async ({ page }) => {
  await open(page, '#/login?next=/admin');
  await page.fill('#u', 'organiser');
  await page.fill('#p', 'organiser-demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible({ timeout: 20_000 });
});

test('reset sample data starts from a fresh database', async ({ page }) => {
  await holdOneSeat(page);
  await page.getByRole('button', { name: 'Reset sample data' }).click();
  await expect(page.locator('#boot')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('.ticket-card')).toHaveCount(3);
});
