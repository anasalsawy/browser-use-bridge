import { chromium } from 'playwright';

const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || '/home/azureuser/.travel-sales-agent/chromium-profile';
const LOGIN_URL = process.env.FB_LOGIN_URL || 'https://www.facebook.com/login/';
const EMAIL = process.env.FB_EMAIL;
const PASSWORD = process.env.FB_PASSWORD;
const OTP_URL = process.env.FB_OTP_URL;
const OTP_TOKEN = process.env.FB_OTP_TOKEN;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(name, value) {
  if (!value) throw new Error(`${name} is not configured`);
}

async function fetchOtp() {
  required('FB_OTP_URL', OTP_URL);
  required('FB_OTP_TOKEN', OTP_TOKEN);
  const response = await fetch(OTP_URL, {
    headers: { authorization: `Bearer ${OTP_TOKEN}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`OTP endpoint HTTP ${response.status}`);
  const data = JSON.parse(body);
  const otp = String(data.code ?? data.otp ?? data.token ?? '').trim();
  if (!/^\d{4,8}$/.test(otp)) throw new Error('OTP endpoint did not return a numeric OTP');
  return otp;
}

async function authenticated(page) {
  const url = page.url();
  if (/\/login(?:[/?#]|$)|checkpoint/i.test(url)) return false;
  const body = await page.locator('body').innerText().catch(() => '');
  return !/Log in|Create new account/i.test(body.slice(0, 5000));
}

async function login() {
  required('FB_EMAIL', EMAIL);
  required('FB_PASSWORD', PASSWORD);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (await authenticated(page)) return { ok: true, authenticated: true, reusedSession: true };

    const email = page.locator('input[name="email"], input[type="email"]').first();
    const password = page.locator('input[name="pass"], input[type="password"]').first();
    await email.waitFor({ state: 'visible', timeout: 30000 });
    await password.waitFor({ state: 'visible', timeout: 30000 });
    await email.fill(EMAIL);
    await password.fill(PASSWORD);

    // Facebook can expose hidden duplicate submit controls. Submit from the visible password field.
    await password.press('Enter');

    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      if (await authenticated(page)) return { ok: true, authenticated: true, reusedSession: false };

      const otpInput = page.locator('input[autocomplete="one-time-code"], input[name*="code" i], input[name*="otp" i], input[inputmode="numeric"]:visible').first();
      if (await otpInput.count()) {
        const otp = await fetchOtp();
        await otpInput.fill(otp);
        await otpInput.press('Enter');
        await sleep(1500);
      }
    }

    if (await authenticated(page)) return { ok: true, authenticated: true, reusedSession: false };
    return { ok: false, authenticated: false, url: page.url() };
  } finally {
    await context.close();
  }
}

login()
  .then((result) => { console.log(JSON.stringify(result)); process.exit(result.ok ? 0 : 1); })
  .catch((error) => { console.error(error.message); process.exit(1); });
