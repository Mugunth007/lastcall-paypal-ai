import { chromium } from 'playwright-core';

const base = process.env.SMOKE_BASE_URL || 'https://lastcall-paypal-ai.vercel.app';
if (process.env.SMOKE_ALLOW_RESET !== 'yes') throw new Error('Set SMOKE_ALLOW_RESET=yes to test and reset the shared demo data.');
const initial = await fetch(`${base}/api/state`).then((response) => response.json());
if (initial.paymentMode !== 'demo') throw new Error('This smoke test requires the labelled demo payment mode.');
const reset = await fetch(`${base}/api/demo/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
if (!reset.ok) throw new Error(`Demo reset failed (${reset.status}): ${await reset.text()}`);

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#voiceButton').click();
  await page.waitForFunction(() => document.querySelector('#voiceButton .voice-label')?.textContent === 'Stop voice');
  await page.locator('#voiceButton').click();
  await page.locator('#matchButton').click();
  await page.locator('#reserveButton').waitFor({ timeout: 90000 });
  const matchLabel = await page.locator('.bundle-tag').innerText();
  await page.locator('#reserveButton').click();
  await page.locator('#approveDemoButton').waitFor();
  await page.locator('#approveDemoButton').click();
  await page.locator('.pickup-code').waitFor();
  const code = (await page.locator('.pickup-code').innerText()).trim();
  if (!/^\d{6}$/.test(code)) throw new Error('Pickup code was not shown.');
  await page.locator('#bakeryTab').click();
  const order = page.locator('.order-card').filter({ has: page.locator('.capture-button') }).first();
  await order.locator('.code-input').fill(code);
  await order.locator('.capture-button').click();
  await page.locator('.status-chip.completed').waitFor();
  const saved = await page.locator('#statSaved').innerText();
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#bakeryTab').click();
  await page.locator('.status-chip.completed').waitFor();
  if (pageErrors.length) throw new Error(`Browser errors: ${pageErrors.join(' | ')}`);
  console.log(JSON.stringify({ matchLabel, savedItems: Number(saved), persistedAfterReload: true, voicePlayed: true, pageErrors: 0 }));
} finally {
  await browser.close();
}
