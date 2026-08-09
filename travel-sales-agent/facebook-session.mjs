import { chromium } from 'playwright';

const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || '/home/azureuser/.travel-sales-agent/chromium-profile';

export async function checkFacebookSession() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    const url = page.url();
    const title = await page.title();
    const loginVisible = await page.locator('input[name="email"], input[name="pass"], #email, #pass').first().isVisible().catch(() => false);
    const loggedIn = !loginVisible && !/\/login(?:[/?]|$)/i.test(url);
    return { ok: true, authenticated: loggedIn, url, title, profile: PROFILE_DIR };
  } finally {
    await context.close();
  }
}

export async function checkOtpRelay() {
  const endpoint = process.env.FB_OTP_GET_URL;
  const token = process.env.FB_OTP_GET_TOKEN;
  if (!endpoint || !token) return { ok: false, configured: false };
  const u = new URL(endpoint);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('OTP relay must use HTTP(S)');
  const r = await fetch(u, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  const body = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  return { ok: r.ok, configured: true, status: r.status, hasCode: Boolean(parsed?.code), response: parsed ? { keys: Object.keys(parsed) } : { contentType: r.headers.get('content-type') } };
}
