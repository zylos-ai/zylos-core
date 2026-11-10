import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Real Chrome and CDP pointer input, owned by the existing isolated case.
// Playwright supplies the transport; the page, server and assertions are real.
export async function startAfterReplyBrowser(t, sandbox, origin) {
  sandbox.assertIsolation();
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN,
    headless: true, env: sandbox.env, timeout: 10000,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  const errors = [], external = [];
  let closing;
  const close = () => closing ||= browser.close();
  sandbox.addCleanup(close); t.after(close);
  t.signal.addEventListener('abort', () => { void close(); }, { once: true });
  return { errors, external, close,
    async page({ width = 1280, pathname, ready }) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });
      sandbox.addCleanup(() => context.close());
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(origin + '/')) return route.continue();
        if (new URL(url).hostname !== 'fonts.googleapis.com' && external.length < 5) external.push(url);
        return route.abort();
      });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
      await page.goto(origin + pathname, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForFunction(ready, null, { timeout: 10000 });
      assert.equal(new URL(page.url()).origin, origin);
      const session = await context.newCDPSession(page);
      return { evaluate: expression => page.evaluate(expression),
        waitFor: expression => page.waitForFunction(expression, null, { timeout: 10000 }),
        screenshot: file => page.screenshot({ path: file, animations: 'disabled', scale: 'css' }),
        call: (method, params) => session.send(method, params) };
    }
  };
}
