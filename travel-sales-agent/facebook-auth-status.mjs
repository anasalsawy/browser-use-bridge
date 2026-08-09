import { chromium } from 'playwright';

const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || '/home/azureuser/.travel-sales-agent/chromium-profile';
const FB_URL = process.env.FB_HOME_URL || 'https://www.facebook.com/';
const OTP_URL = process.env.FB_OTP_URL;
const OTP_TOKEN = process.env.FB_OTP_TOKEN;

export async function facebookSessionStatus() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(FB_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const url = page.url();
    const text = await page.locator('body').innerText().catch(() => '');
    const authenticated = !/\/login(?:[/?#]|$)|checkpoint/i.test(url) && !/log in|create new account/i.test(text.slice(0, 4000));
    return { ok: true, authenticated, url };
  } finally {
    await context.close();
  }
}

export async function otpRelayStatus() {
  if (!OTP_URL || !OTP_TOKEN) return { ok: false, configured: false };
  const response = await fetch(OTP_URL, {
    headers: { authorization: `Bearer ${OTP_TOKEN}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (!response.ok) return { ok: false, configured: true, available: false, status: response.status };
  try {
    const data = JSON.parse(text);
    const code = String(data.code || data.otp || data.token || '').trim();
    return { ok: true, configured: true, available: /^\d{4,8}$/.test(code) };
  } catch {
    return { ok: false, configured: true, available: false, invalidResponse: true };
  }
}
