import { chromium } from 'playwright';

const LOGIN_URL = process.env.FB_LOGIN_URL || 'https://www.facebook.com/login/';
const OTP_URL = process.env.FB_OTP_GET_URL;
const OTP_BEARER = process.env.FB_OTP_GET_TOKEN;
const USERNAME = process.env.FB_USERNAME;
const SECRET = process.env.FB_PASSWORD;
const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || '/home/azureuser/.travel-sales-agent/chromium-profile';

async function getOtp() {
  if (!OTP_URL || !OTP_BEARER) throw new Error('FB OTP relay is not configured');
  const r = await fetch(OTP_URL, { headers: { authorization: `Bearer ${OTP_BEARER}`, accept: 'application/json' } });
  if (!r.ok) throw new Error(`OTP relay returned HTTP ${r.status}`);
  const body = await r.json();
  const code = body.code ?? body.otp ?? body.token;
  if (!code) throw new Error('OTP relay returned no code');
  return String(code);
}

export async function authenticateFacebook() {
  if (!USERNAME || !SECRET) throw new Error('Facebook auth credentials are not configured');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input[name="email"], input[name="username"], input[type="email"]').first().fill(USERNAME, { timeout: 20000 });
    await page.locator('input[name="pass"], input[type="password"]').first().fill(SECRET, { timeout: 20000 });
    await page.locator('button[type="submit"], button[name="login"], input[type="submit"]').first().click({ timeout: 20000 });
    await page.waitForTimeout(3000);
    const otpField = page.locator('input[autocomplete="one-time-code"], input[name*="code" i], input[name*="otp" i]').first();
    if (await otpField.count()) {
      const code = await getOtp();
      await otpField.fill(code, { timeout: 20000 });
      await page.locator('button[type="submit"], button[name="continue"], input[type="submit"]').first().click({ timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(4000);
    }
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const title = await page.title();
    const url = page.url();
    const loggedIn = !/\/login(?:\/|\?|$)/i.test(url) && !/log in/i.test(title);
    if (!loggedIn) throw new Error('Facebook authentication could not be verified');
    return { ok: true, url, title };
  } finally {
    await context.close();
  }
}
