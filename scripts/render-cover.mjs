import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
});
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(process.cwd(), 'demo', 'cover.html')).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(process.cwd(), 'demo', 'lastcall-cover.png') });
  console.log('Cover saved: demo/lastcall-cover.png (1500 x 1000)');
} finally {
  await browser.close();
}
