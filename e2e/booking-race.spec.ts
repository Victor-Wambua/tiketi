import { expect, test, type Browser, type Page } from '@playwright/test';

const DEPARTURE = 'dep-nakuru-shuttle-3';

async function freeSeats(page: Page): Promise<string[]> {
  const r = await page.request.get(`/api/departures/${DEPARTURE}/seats`);
  const { states } = (await r.json()) as { states: Record<string, string> };
  return Object.entries(states)
    .filter(([, s]) => s === 'available')
    .map(([id]) => id);
}

const seat = (page: Page, id: string) => page.locator(`g.seat[data-seat="${id}"]`);

async function openDeparture(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  await page.goto(`/d/${DEPARTURE}`);
  await expect(page.locator('g.seat').first()).toBeVisible();
  return { context, page };
}

async function payAndGetTicket(page: Page, name: string, phone: string) {
  await page.fill('#f-name', name);
  await page.fill('#f-phone', phone);
  await page.getByRole('button', { name: /Pay KES/ }).click();
  await page.locator('[data-outcome="success"]').click();
  await expect(page).toHaveURL(/\/t\/tkt_/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const code = (await page.locator('.code-text').textContent())!.trim();
  expect(code).toMatch(/^TK1\./);
  return code;
}

test('two shoppers race for one seat: one wins, the other is told and picks another; pay, ticket, gate admits once', async ({
  browser,
}) => {
  const a = await openDeparture(browser);
  const b = await openDeparture(browser);
  const [target, other] = await freeSeats(a.page);
  expect(target && other).toBeTruthy();

  // Both select the same free seat.
  await seat(a.page, target!).click();
  await seat(b.page, target!).click();
  await expect(seat(a.page, target!)).toHaveClass(/is-selected/);
  await expect(seat(b.page, target!)).toHaveClass(/is-selected/);

  // Both press "Hold seats" at the same moment.
  const hold = (p: Page) => p.getByRole('button', { name: 'Hold seats' }).last().click();
  await Promise.all([hold(a.page), hold(b.page)]);

  const heldHeading = (p: Page) => p.getByRole('heading', { name: 'Seats held for you' });
  const takenNotice = (p: Page) => p.getByText(/just taken by someone else/).first();
  await expect
    .poll(async () => (await heldHeading(a.page).count()) + (await heldHeading(b.page).count()))
    .toBe(1);
  const aWon = await heldHeading(a.page).isVisible();
  const winner = aWon ? a : b;
  const loser = aWon ? b : a;
  await expect(heldHeading(winner.page)).toBeVisible();
  await expect(heldHeading(loser.page)).toHaveCount(0);
  await expect(takenNotice(loser.page)).toBeVisible();
  // The map on both screens now shows the seat as taken (held for me / held by someone else).
  await expect(seat(winner.page, target!)).toHaveClass(/is-mine/);
  await expect(seat(loser.page, target!)).toHaveClass(/is-held/);

  // The loser picks another seat and succeeds.
  await seat(loser.page, other!).click();
  await loser.page.getByRole('button', { name: 'Hold seats' }).last().click();
  await expect(heldHeading(loser.page)).toBeVisible();

  // Both pay with the mock M-Pesa phone and get tickets.
  const winnerCode = await payAndGetTicket(winner.page, 'Winner Test', '0700 000 011');
  const loserCode = await payAndGetTicket(loser.page, 'Second Test', '0700 000 012');
  await expect(winner.page.getByText('Valid', { exact: true })).toBeVisible();
  await expect(winner.page.locator('.qr-box svg')).toBeVisible();

  // Gate staff: sign in on another device.
  const gateCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const gate = await gateCtx.newPage();
  await gate.goto('/gate');
  await gate.fill('#u', 'gate1');
  await gate.fill('#p', 'gate-demo-pass');
  await gate.getByRole('button', { name: 'Sign in' }).click();
  await expect(gate.getByRole('heading', { name: 'Gate scanner' })).toBeVisible();
  await gate.locator('#dep').selectOption(DEPARTURE);
  await expect(gate.getByText(/Ticket list on this device: \d+ tickets/)).toBeVisible();

  const scan = async (code: string) => {
    await gate.fill('#code', code);
    await gate.getByRole('button', { name: 'Check ticket' }).click();
  };
  const verdict = gate.locator('.verdict');

  await scan(winnerCode);
  await expect(verdict).toHaveAttribute('data-kind', 'admitted');
  await expect(verdict).toContainText('Winner Test');

  // Replay of the same code is refused, with when and where.
  await scan(winnerCode);
  await expect(verdict).toHaveAttribute('data-kind', 'duplicate');
  await expect(verdict).toContainText(/Already scanned at \d\d:\d\d at Gate A/);

  // A tampered code is rejected.
  const parts = loserCode.split('.');
  parts[3] = parts[3] === '1' ? '2' : '1';
  await scan(parts.join('.'));
  await expect(verdict).toHaveAttribute('data-kind', 'rejected');
  await expect(verdict).toContainText(/Fake or altered/);

  // Offline: the second ticket is verified in the browser, admitted, queued, then reconciled.
  await gate.getByLabel('Work offline (simulate no signal)').check();
  await expect(gate.getByText('Offline mode')).toBeVisible();
  await scan(loserCode);
  await expect(verdict).toHaveAttribute('data-kind', 'admitted');
  await expect(verdict).toContainText('Admitted offline');
  await expect(gate.getByText('1 queued')).toBeVisible();
  await gate.getByLabel('Work offline (simulate no signal)').uncheck();
  await expect(gate.getByText('0 queued')).toBeVisible();

  // The server now knows both entries; a replay of the offline one is refused online too.
  await scan(loserCode);
  await expect(verdict).toHaveAttribute('data-kind', 'duplicate');

  // The ticket page of the winner now says it was used.
  await winner.page.reload();
  await expect(winner.page.getByText(/This ticket was used at \d\d:\d\d/)).toBeVisible();

  await Promise.all([a.context.close(), b.context.close(), gateCtx.close()]);
});

test('organiser dashboard shows live numbers and enforces roles', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login/);
  await page.fill('#u', 'gate1');
  await page.fill('#p', 'gate-demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // gate staff are not organisers: they are sent back to sign in when they open the dashboard
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login/);
  await page.request.post('/api/auth/logout', { data: {} });
  await page.goto('/login?next=/admin');
  await page.fill('#u', 'organiser');
  await page.fill('#p', 'organiser-demo-pass');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Seat heat map')).toBeVisible();
  await expect(page.locator('.kpi').first()).toContainText(/\d+\/\d+/);
  const csv = await page.request.get(`/api/admin/departures/${DEPARTURE}/export.csv`);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain('ticket_id,seat');
  await ctx.close();
});
