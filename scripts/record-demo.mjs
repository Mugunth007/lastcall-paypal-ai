import { mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.env.DEMO_BASE_URL || 'http://localhost:3000';
const demoDir = join(process.cwd(), '.data', 'demo');
await mkdir(demoDir, { recursive: true });
const state = await fetch(`${base}/api/state`).then((response) => response.json());
if (state.paymentMode !== 'demo') throw new Error('Recording script only supports clearly labelled demo payments.');
const reset = await fetch(`${base}/api/demo/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
if (!reset.ok) throw new Error(`Could not reset demo: ${reset.status}`);

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--no-sandbox']
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, recordVideo: { dir: demoDir, size: { width: 1440, height: 900 } } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const pause = (milliseconds) => page.waitForTimeout(milliseconds);

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('#inventoryGrid .inventory-card').first().waitFor();
  await pause(4000);
  await page.locator('.workspace').scrollIntoViewIfNeeded();
  await pause(2000);
  await page.locator('#requestInput').fill('A savory dinner and a little sweet treat, please.');
  await pause(1500);
  await page.locator('#matchButton').click();
  await page.locator('#reserveButton').waitFor({ timeout: 60000 });
  await pause(5000);
  await page.locator('#reserveButton').click();
  await page.locator('#approveDemoButton').waitFor();
  await pause(3000);
  await page.locator('#approveDemoButton').click();
  await page.locator('.pickup-code').waitFor();
  const code = (await page.locator('.pickup-code').innerText()).trim();
  if (!/^\d{6}$/.test(code)) throw new Error('A six digit pickup code was not displayed.');
  await pause(5500);
  await page.locator('#bakeryTab').click();
  await pause(3000);
  const order = page.locator('.order-card').filter({ has: page.locator('.capture-button') }).first();
  await order.locator('.code-input').fill(code);
  await pause(2200);
  await order.locator('.capture-button').click();
  await page.locator('.status-chip.completed').first().waitFor();
  await pause(5000);
  await page.locator('#shopTab').click();
  await page.locator('#bundlePanel').scrollIntoViewIfNeeded();
  await pause(4500);
  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
} finally {
  const source = await page.video().path();
  await context.close();
  await copyFile(source, join(demoDir, 'walkthrough.webm'));
  await browser.close();
}
console.log(`Walkthrough saved: ${join(demoDir, 'walkthrough.webm')}`);
