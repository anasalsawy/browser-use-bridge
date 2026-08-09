import { chromium } from 'playwright';

const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || '/home/azureuser/.travel-sales-agent/chromium-profile';
const FB_LOGIN_URL = process.env.FB_LOGIN_URL || 'https://www.facebook.com/login/';
const FB_EMAIL = process.env.FB_EMAIL;
const FB_PASSWORD = process.env.FB_PASSWORD;
const FB_OTP_URL = process.env.FB_OTP_URL;
const FB_OTP_TOKEN = process.env.FB_OTP_TOKEN;

function requireConfig() {
  const missing = [];
  if (!FB_EMAIL) missing.push('FB_EMAIL');
  if (!FB_PASSWORD) missing.push('FB_PASSWORD');
  if (!FB_OTP_URL) missing.push('FB_OTP_URL');
  if (!FB_OTP_TOKEN) missing.push('FB_OTP_TOKEN');
  if (missing.length) throw new Error(`Facebook auth configuration missing: ${missing.join(', ')}`);
}

async function fetchOtp() {
  const response = await fetch(FB_OTP_URL, {
    headers: { authorization: `Bearer ${FB_OTP_TOKEN}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OTP endpoint ${response.status}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('OTP endpoint did not return JSON'); }
  const code = String(data.code || data.otp || data.token || '').trim();
  if (!/^\d{4,8}$/.test(code)) throw new Error('OTP endpoint returned no valid code');
  return code;
}

export async function facebookLogin() {
  requireConfig();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(FB_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input[name="email"], input[type="email"]').first().fill(FB_EMAIL, { timeout: 20000 });
    await page.locator('input[name="pass"], input[type="password"]').first().fill(FB_PASSWORD, { timeout: 20000 });
    await page.locator('button[name="login"], button[type="submit"], input[type="submit"]').first().click({ timeout: 20000 });
    await page.waitForTimeout(3000);

    for (let attempt = 0; attempt < 3; attempt++) {
      const url = page.url();
      const body = await page.locator('body').innerText().catch(() => '');
      const needsCode = /code|verification|authenticate|two-factor|2-factor|security check/i.test(body);
      if (!needsCode && !/login|checkpoint/i.test(url)) break;
      if (needsCode) {
        const otp = await fetchOtp();
        const selector = 'input[name*="code"], input[name*="otp"], input[autocomplete="one-time-code"], input[type="text"]';
        await page.locator(selector).first().fill(otp, { timeout: 20000 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(4000);
      } else {
        await page.waitForTimeout(3000);
      }
    }

    const finalUrl = page.url();
    const finalText = await page.locator('body').innerText().catch(() => '');
    const authenticated = !/\/login|checkpoint/i.test(finalUrl) && /facebook/i.test(finalUrl);
    if (!authenticated) throw new Error(`Facebook authentication not verified; final URL: ${finalUrl}`);
    return { ok: true, authenticated: true, url: finalUrl, title: await page.title() };
  } finally {
    await context.close();
  }
}
