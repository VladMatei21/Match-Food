import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApp } from '../server/app.mjs';

async function fixture(t, mode, viewport = { width: 1440, height: 1000 }) {
  let dataDir, server, close, url, standaloneHtml;
  if (mode === 'standalone') {
    const artifact = fileURLToPath(new URL('../standalone/MatchFood.html', import.meta.url));
    assert.ok(existsSync(artifact), 'Run npm run build:standalone before standalone browser tests.');
    standaloneHtml = await readFile(artifact);
    url = 'http://matchfood-standalone.test/MatchFood.html';
    t.diagnostic('Managed Chromium blocks file URLs; standalone HTML bytes are loaded through an in-memory route with the browser offline.');
  } else {
    assert.ok(existsSync(new URL('../dist/index.html', import.meta.url)), 'Run npm run build before server browser tests.');
    dataDir = await mkdtemp(path.join(tmpdir(), 'matchfood-workflows-'));
    const instance = createApp({ dataDir, enableDemo: true });
    close = instance.close;
    server = instance.app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    url = `http://127.0.0.1:${server.address().port}`;
  }
  const stopServer = async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    close();
    await rm(dataDir, { recursive: true, force: true });
  };
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  } catch (error) {
    await stopServer();
    throw error;
  }
  const context = await browser.newContext({ viewport, offline: mode === 'standalone' });
  if (mode === 'standalone') {
    await context.route(url, route => route.fulfill({ status: 200, contentType: 'text/html', body: standaloneHtml }));
  }
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  const unexpectedRequests = [];
  page.on('request', request => {
    const requested = request.url();
    const allowed = requested.startsWith('data:')
      || (mode === 'standalone' ? requested === url : requested.startsWith(`${url}/`));
    if (!allowed) unexpectedRequests.push(requested);
  });
  t.after(async () => {
    await browser.close();
    await stopServer();
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'How will you use MatchFood?', exact: true }).waitFor();
  return { page, runtimeErrors, unexpectedRequests };
}

async function assertRoleEntry(page) {
  await page.getByRole('heading', { name: 'How will you use MatchFood?', exact: true }).waitFor();
  assert.equal(await page.locator('.food-card').count(), 0, 'Food is hidden until a role is chosen.');
  assert.equal(await page.locator('.sidebar').count(), 0, 'The entry page has no app sidebar.');
  assert.equal(await page.getByRole('navigation').count(), 0, 'The entry page has no app navigation.');
  assert.doesNotMatch(await page.locator('body').innerText(), /\b(presentation|demo|classroom)\b/i, 'Entry copy describes the product without demonstration labels.');
  assert.equal(await page.getByRole('button', { name: /I’m a donor/ }).count(), 1);
  assert.equal(await page.getByRole('button', { name: /I’m a charity/ }).count(), 1);
}

async function chooseRole(page, role) {
  const roleSwitch = page.getByRole('button', { name: 'Switch role', exact: true });
  if (await roleSwitch.count()) {
    await roleSwitch.click();
    await assertRoleEntry(page);
  }
  await page.getByRole('button', { name: role === 'donor' ? /I’m a donor/ : /I’m a charity/ }).click();
  await page.getByRole('button', { name: 'Switch role', exact: true }).waitFor();
  await page.locator(role === 'donor' ? '.charity-card' : '.food-card').first().waitFor();
  assert.equal((await page.locator('.role-switch').innerText()).trim(), role === 'donor' ? 'Donor' : 'Charity');
}

async function openRequests(page, role) {
  const name = role === 'donor' ? /^Incoming requests/ : /^My requests/;
  await page.getByRole('navigation').getByRole('button', { name }).click();
  await page.locator('.request-card').first().waitFor();
}

async function setLocation(page, city) {
  await page.locator('.location-select').click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('select').first().selectOption({ label: city });
  await dialog.getByRole('button', { name: /^(Find food nearby|Find charities nearby|Find nearby charities|Show nearby|Apply location|Update location)$/ }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function assertFitsMobile(page, context) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${context} fits a 375 px viewport.`);
}

for (const mode of ['server', 'standalone']) {
  const modeLabel = mode === 'standalone' ? 'standalone HTML (offline served bytes)' : 'server';

  test(`${modeLabel}: explicit roles, nearby charities, donation request, contact sharing, reload gating and collection`, { timeout: 120_000 }, async t => {
    const { page, runtimeErrors, unexpectedRequests } = await fixture(t, mode);
    await assertRoleEntry(page);
    await chooseRole(page, 'donor');
    assert.equal(await page.locator('.food-card').count(), 0, 'The donor overview shows nearby charities, not other donors’ food.');
    assert.equal(await page.locator('.charity-card').count(), 3);
    await page.getByRole('navigation').getByRole('button', { name: /^My donations/ }).click();
    await page.locator('.food-card').first().waitFor();
    assert.equal(await page.locator('.food-card').count(), 2, 'Donors see only their two own initial donations.');
    const ownOrganizations = await page.locator('.food-card .food-donor').allTextContents();
    assert.ok(ownOrganizations.every(value => value.includes('The Good Loaf')), 'Another donor’s food is not shown to the donor.');
    assert.equal(await page.getByRole('navigation').getByRole('button', { name: /Discover food|Find food|Saved food/ }).count(), 0);
    assert.equal(await page.getByRole('navigation').getByRole('button', { name: /^My donations/ }).count(), 1);

    await page.getByRole('navigation').getByRole('button', { name: /^Nearby charities/ }).click();
    await page.locator('.charity-card').first().waitFor();
    assert.equal(await page.locator('.charity-card').count(), 3, 'Three local charities can be discovered by a donor.');
    const firstCharity = (await page.locator('.charity-card h3').first().innerText()).trim();
    await page.getByRole('textbox', { name: 'Search charities', exact: true }).fill(firstCharity);
    await page.waitForFunction(() => document.querySelectorAll('.charity-card').length === 1);
    assert.equal((await page.locator('.charity-card h3').innerText()).trim(), firstCharity);
    await page.getByRole('textbox', { name: 'Search charities', exact: true }).fill('');
    await page.waitForFunction(() => document.querySelectorAll('.charity-card').length === 3);
    await setLocation(page, 'Bucharest');
    await page.waitForFunction(() => document.querySelectorAll('.charity-card').length === 0);
    await setLocation(page, 'London');
    await page.locator('.charity-card').first().waitFor();
    assert.equal(await page.locator('.charity-card').count(), 3, 'Changing the search location updates nearby charities.');

    await page.getByRole('button', { name: 'Edit your profile', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Business or institution', { exact: true }).fill('Community Kitchen');
    await dialog.locator('select[name=businessType]').selectOption('Restaurant');
    const mapsLink = 'https://www.google.com/maps/@51.5055,-0.0909,16z';
    await dialog.getByLabel(/Google Maps place link/).fill(mapsLink);
    await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Edit your profile', exact: true }).click();
    dialog = page.getByRole('dialog');
    assert.equal(await dialog.getByLabel('Business or institution', { exact: true }).inputValue(), 'Community Kitchen');
    assert.equal(await dialog.locator('select[name=businessType]').inputValue(), 'Restaurant');
    assert.equal(await dialog.getByLabel(/Google Maps place link/).inputValue(), mapsLink);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('navigation').getByRole('button', { name: /^My donations/ }).click();
    await page.getByRole('button', { name: 'Donate food', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('What are you sharing?', { exact: true }).fill('Community soup');
    await dialog.locator('select[name=category]').selectOption('prepared');
    await dialog.getByLabel('Quantity available', { exact: true }).fill('10');
    await dialog.locator('select[name=unit]').selectOption('portions');
    await dialog.getByLabel('A little more about the food', { exact: true }).fill('Fresh vegetable soup, chilled safely and packed in sealed containers for our community.');
    await dialog.getByLabel('Collection window', { exact: true }).fill('Tomorrow, 10 am–12 pm');
    await dialog.getByRole('button', { name: /^(Donate food|Share food)$/ }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('.charity-card').first().waitFor();
    await page.getByRole('navigation').getByRole('button', { name: /^My donations/ }).click();
    await page.getByRole('button', { name: 'Community soup', exact: true }).waitFor();

    await chooseRole(page, 'charity');
    assert.equal(await page.locator('.food-card').count(), 7, 'Charities can see donations from all donors.');
    assert.ok((await page.locator('.food-card .food-donor').allTextContents()).some(value => value.includes('Green Basket Market')));
    assert.equal(await page.getByRole('button', { name: /Donate food/ }).count(), 0, 'The charity has no donor creation controls.');
    await page.getByRole('textbox', { name: 'Search food or organisations', exact: true }).fill('Community soup');
    await page.getByRole('button', { name: 'Community soup', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Community soup', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Your message/).fill('Hello! We can collect all ten portions tomorrow morning for our community lunch.');
    await dialog.getByRole('button', { name: 'Send pickup request', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    let request = page.locator('.request-card').filter({ hasText: 'Community soup' });
    await request.getByText('Awaiting donor', { exact: true }).waitFor();
    assert.equal(await request.locator('.contact-card').count(), 0, 'Donor contact remains private until acceptance.');

    await chooseRole(page, 'donor');
    await openRequests(page, 'donor');
    request = page.locator('.request-card').filter({ hasText: 'Community soup' });
    await request.getByRole('button', { name: 'Accept request', exact: true }).click();
    await request.getByText('Ready for pickup', { exact: true }).waitFor();
    await chooseRole(page, 'charity');
    await openRequests(page, 'charity');
    request = page.locator('.request-card').filter({ hasText: 'Community soup' });
    await request.locator('.contact-card').waitFor();
    assert.equal(await request.locator('.contact-card a[href^="mailto:"]').count(), 1);
    assert.equal(await request.getByRole('link', { name: /View on Google Maps/ }).getAttribute('href'), mapsLink);

    await page.reload({ waitUntil: 'networkidle' });
    await assertRoleEntry(page);
    await chooseRole(page, 'charity');
    await openRequests(page, 'charity');
    request = page.locator('.request-card').filter({ hasText: 'Community soup' });
    await request.getByText('Ready for pickup', { exact: true }).waitFor();
    assert.equal(await request.locator('.contact-card a[href^="mailto:"]').count(), 1, 'Saved profile and accepted request survive explicit role selection after reload.');
    assert.equal(await request.getByRole('link', { name: /View on Google Maps/ }).getAttribute('href'), mapsLink);

    await chooseRole(page, 'donor');
    await openRequests(page, 'donor');
    request = page.locator('.request-card').filter({ hasText: 'Community soup' });
    await request.getByRole('button', { name: 'Mark as collected', exact: true }).click();
    await request.getByText('Collected', { exact: true }).waitFor();
    await chooseRole(page, 'charity');
    assert.equal(await page.getByRole('button', { name: 'Community soup', exact: true }).count(), 0, 'Collected food is no longer available in the charity feed.');
    await openRequests(page, 'charity');
    await page.locator('.request-card').filter({ hasText: 'Community soup' }).getByText('Collected', { exact: true }).waitFor();
    assert.deepEqual(runtimeErrors, [], 'No browser runtime errors across the complete workflow.');
    assert.deepEqual(unexpectedRequests, [], 'The workflow uses only bundled assets and local API calls.');
  });

  test(`${modeLabel}: mobile role-first workflows fit and the profile dialog keeps keyboard focus`, { timeout: 60_000 }, async t => {
    const { page, runtimeErrors, unexpectedRequests } = await fixture(t, mode, { width: 375, height: 812 });
    await assertRoleEntry(page);
    await assertFitsMobile(page, 'Role selection');
    await chooseRole(page, 'donor');
    assert.equal(await page.locator('.charity-card').count(), 3);
    await assertFitsMobile(page, 'Donor overview');
    await page.getByRole('navigation').getByRole('button', { name: /^My donations/ }).click();
    await page.locator('.food-card').first().waitFor();
    assert.equal(await page.locator('.food-card').count(), 2);
    await assertFitsMobile(page, 'Donor donations');
    await page.getByRole('button', { name: 'Edit your profile', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await assertFitsMobile(page, 'Profile dialog');
    for (let i = 0; i < 18; i++) {
      await page.keyboard.press('Tab');
      assert.ok(await dialog.evaluate(element => element.contains(document.activeElement)), 'Tab focus stays inside the profile dialog.');
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await chooseRole(page, 'charity');
    assert.equal(await page.locator('.food-card').count(), 6);
    await assertFitsMobile(page, 'Charity page');
    await page.locator('.food-card').first().getByRole('button', { name: /^View / }).click();
    await page.getByRole('dialog').waitFor();
    await assertFitsMobile(page, 'Food details');
    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
    assert.deepEqual(runtimeErrors, []);
    assert.deepEqual(unexpectedRequests, []);
  });
}

test('unavailable API shows a useful connection error instead of crashing the charity food feed', { timeout: 30_000 }, async t => {
  const { page, runtimeErrors, unexpectedRequests } = await fixture(t, 'server');
  await chooseRole(page, 'charity');
  assert.equal(await page.locator('.food-card').count(), 6);
  await page.route('**/api/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body>Static host fallback</body></html>'
  }));
  await page.getByRole('textbox', { name: 'Search food or organisations', exact: true }).fill('soup');
  await page.getByRole('heading', { name: 'We couldn’t load the food feed', exact: true }).waitFor();
  await page.getByText('We couldn’t connect to MatchFood. Please reload and try again.', { exact: true }).waitFor();
  assert.deepEqual(runtimeErrors, [], 'An unavailable API must not cause a browser runtime crash.');
  assert.deepEqual(unexpectedRequests, []);
});
