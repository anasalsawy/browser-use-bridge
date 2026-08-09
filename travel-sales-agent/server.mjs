import http from 'node:http';
import { chromium } from 'playwright';
import { runFacebookAuthLLM } from './facebook-llm-auth.mjs';

const PORT = Number(process.env.TRAVEL_AGENT_PORT || 8890);
const API_KEY = process.env.HF_TOKEN;
const BASE_URL = (process.env.AI_BASE_URL || 'https://router.huggingface.co/v1').replace(/\/$/, '');
const MODELS = [process.env.AI_MODEL || 'openai/gpt-oss-120b:fastest', 'openai/gpt-oss-20b:fastest', 'deepseek-ai/DeepSeek-R1:fastest'];
const PROVIDER = 'huggingface';
const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || '/home/azureuser/.travel-sales-agent/chromium-profile';
const SYSTEM_PROMPT = `You are the autonomous travel sales agent for Your Travel Agent. Do real company work, not role-play. Use connected headless Chromium for legitimate web work. You may authenticate Facebook when needed using the dedicated Facebook authentication tools. You must inspect the page and decide what action is appropriate; do not rely on fixed login selectors. The credential and OTP tools inject secrets directly into the browser and never return the secret values to you. Never expose secrets. Never invent bookings, prices, availability, customer data, or completed actions. Before consequential purchase/payment actions, require explicit customer authorization. When login is required, navigate to the site's login page, inspect it, use the Facebook credential tools with selectors you observe, submit the form, inspect the resulting page, retrieve OTP only when Facebook requests it, enter it with the OTP tool, and verify authentication from the resulting page. If Facebook presents a checkpoint, captcha, identity challenge, or anything requiring human action, report that clearly rather than pretending success.`;

if (!API_KEY) { console.error('HF_TOKEN is required'); process.exit(1); }

let browserContext = null;
let browserPage = null;
let browserInitPromise = null;
let shuttingDown = false;

async function ensureBrowser() {
  if (shuttingDown) throw new Error('Travel sales agent is shutting down');
  if (browserContext && browserPage) {
    try {
      if (browserContext.browser()?.isConnected() && !browserPage.isClosed()) return browserPage;
    } catch {}
    browserContext = null;
    browserPage = null;
  }
  if (browserInitPromise) return browserInitPromise;
  browserInitPromise = (async () => {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      viewport: { width: 1440, height: 1000 },
      handleSIGTERM: false,
      handleSIGINT: false,
      handleSIGHUP: false,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    if (shuttingDown) {
      await context.close().catch(() => {});
      throw new Error('Travel sales agent is shutting down');
    }
    const page = context.pages()[0] || await context.newPage();
    browserContext = context;
    browserPage = page;
    context.on('close', () => {
      if (browserContext === context) {
        browserContext = null;
        browserPage = null;
      }
    });
    return page;
  })().finally(() => {
    browserInitPromise = null;
  });
  return browserInitPromise;
}

async function browserNavigate(url) {
  const page = await ensureBrowser();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return JSON.stringify({ ok: true, url: page.url(), title: await page.title() });
}

async function browserSnapshot() {
  const page = await ensureBrowser();
  const text = await page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
  return JSON.stringify({ ok: true, url: page.url(), title: await page.title(), text: text.slice(0, 24000) });
}

async function browserClick(selector) {
  const page = await ensureBrowser();
  await page.locator(selector).filter({ visible: true }).first().click({ timeout: 20000 });
  await page.waitForTimeout(500);
  return JSON.stringify({ ok: true, url: page.url(), title: await page.title() });
}

async function browserType(selector, text) {
  if (/(password|passwd|cvv|cvc|card.?number|otp|one.?time|verification.?code)/i.test(selector)) {
    throw new Error('Secret-entry selectors are blocked; use facebook_auth_input or facebook_otp_input.');
  }
  const page = await ensureBrowser();
  await page.locator(selector).filter({ visible: true }).first().fill(String(text), { timeout: 20000 });
  return JSON.stringify({ ok: true });
}

async function browserPress(selector, key) {
  const page = await ensureBrowser();
  await page.locator(selector).filter({ visible: true }).first().press(key, { timeout: 20000 });
  await page.waitForTimeout(500);
  return JSON.stringify({ ok: true, url: page.url(), title: await page.title() });
}

async function browserWait(ms) {
  const page = await ensureBrowser();
  await page.waitForTimeout(Math.min(Math.max(Number(ms) || 1000, 100), 30000));
  return JSON.stringify({ ok: true, url: page.url(), title: await page.title() });
}

async function browserClose() {
  const context = browserContext;
  browserContext = null;
  browserPage = null;
  if (context) await context.close().catch(() => {});
  return JSON.stringify({ ok: true });
}

async function webFetch(url) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
  const r = await fetch(u, { redirect: 'follow' });
  const text = await r.text();
  return JSON.stringify({ ok: r.ok, status: r.status, url: r.url, body: text.slice(0, 20000) });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured on the VM`);
  return value;
}

async function facebookAuthInput(kind, selector) {
  if (!['email', 'password'].includes(kind)) throw new Error('kind must be email or password');
  const page = await ensureBrowser();
  const secret = requireEnv(kind === 'email' ? 'FB_EMAIL' : 'FB_PASSWORD');
  const loc = page.locator(selector).filter({ visible: true }).first();
  await loc.fill(secret, { timeout: 20000 });
  return JSON.stringify({ ok: true, kind, filled: true });
}

async function facebookOtpGet() {
  const url = process.env.FB_OTP_GET_URL || process.env.FB_OTP_URL;
  const token = process.env.FB_OTP_GET_TOKEN || process.env.FB_OTP_TOKEN;
  if (!url || !token) throw new Error('Facebook OTP GET relay is not configured');
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('OTP URL must use HTTP(S)');
  const r = await fetch(u, { headers: { authorization: `Bearer ${token}`, accept: 'application/json,text/plain,*/*' }, redirect: 'follow' });
  const text = await r.text();
  if (!r.ok) throw new Error(`OTP endpoint returned HTTP ${r.status}`);
  let code = '';
  try { const d = JSON.parse(text); code = String(d.code ?? d.otp ?? d.token ?? d.value ?? ''); } catch { code = text.trim(); }
  if (!/^\d{4,8}$/.test(code)) throw new Error('OTP endpoint did not return a numeric OTP');
  return JSON.stringify({ ok: true, otp_available: true });
}

async function facebookOtpInput(selector) {
  const url = process.env.FB_OTP_GET_URL || process.env.FB_OTP_URL;
  const token = process.env.FB_OTP_GET_TOKEN || process.env.FB_OTP_TOKEN;
  if (!url || !token) throw new Error('Facebook OTP GET relay is not configured');
  const u = new URL(url);
  const r = await fetch(u, { headers: { authorization: `Bearer ${token}`, accept: 'application/json,text/plain,*/*' }, redirect: 'follow' });
  const text = await r.text();
  if (!r.ok) throw new Error(`OTP endpoint returned HTTP ${r.status}`);
  let code = '';
  try { const d = JSON.parse(text); code = String(d.code ?? d.otp ?? d.token ?? d.value ?? ''); } catch { code = text.trim(); }
  if (!/^\d{4,8}$/.test(code)) throw new Error('OTP endpoint did not return a numeric OTP');
  const page = await ensureBrowser();
  const field = page.locator(selector).filter({ visible: true }).first();
  await field.fill(code, { timeout: 20000 });
  return JSON.stringify({ ok: true, otp_entered: true });
}

async function facebookAuthStatus() {
  const page = await ensureBrowser();
  const url = page.url();
  const title = await page.title();
  const text = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  const blob = `${url}\n${title}\n${text}`;
  const checkpoint = /checkpoint|confirm your identity|security check|captcha/i.test(blob);
  const loginUrl = /facebook\.com/i.test(url) && /\/login(?:[/?#]|$)/i.test(url);
  const emailField = await page.locator('input[name="email"], input[type="email"]').filter({ visible: true }).count().catch(() => 0);
  const passwordField = await page.locator('input[name="pass"], input[type="password"]').filter({ visible: true }).count().catch(() => 0);
  const loginForm = emailField > 0 || passwordField > 0;
  const authenticated = /facebook\.com/i.test(url) && !loginUrl && !loginForm && !checkpoint;
  return JSON.stringify({ ok: true, authenticated, checkpoint, login_form: loginForm, url, title });
}

const tools = [
  { type: 'function', function: { name: 'browser_navigate', description: 'Open a URL in the persistent headless Chromium browser.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_snapshot', description: 'Read visible page text and current URL/title.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_click', description: 'Click a visible element using a CSS selector you observed.', parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } } },
  { type: 'function', function: { name: 'browser_type', description: 'Fill a visible non-secret field.', parameters: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector','text'] } } },
  { type: 'function', function: { name: 'browser_press', description: 'Press a key on a visible element.', parameters: { type: 'object', properties: { selector: { type: 'string' }, key: { type: 'string' } }, required: ['selector','key'] } } },
  { type: 'function', function: { name: 'browser_wait', description: 'Wait briefly for the page to update.', parameters: { type: 'object', properties: { ms: { type: 'integer', minimum: 100, maximum: 30000 } }, required: ['ms'] } } },
  { type: 'function', function: { name: 'browser_close', description: 'Close browser while retaining persistent profile.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'web_fetch', description: 'Fetch a public HTTP(S) URL for research.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'qualify_lead', description: 'Extract known travel requirements.', parameters: { type: 'object', properties: { origin: { type: 'string' }, destination: { type: 'string' }, dates: { type: 'string' }, passengers: { type: 'string' }, cabin: { type: 'string' }, trip_type: { type: 'string' }, missing: { type: 'array', items: { type: 'string' } } }, required: ['missing'] } } },
  { type: 'function', function: { name: 'facebook_authenticate', description: 'Run the LLM-driven Facebook authentication flow on the CURRENT persistent browser session. The sub-agent inspects the live page, selects login controls, injects credentials securely, retrieves the existing OTP through the VM relay when Facebook asks for it, and verifies authentication. Never expose credentials or OTP.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'facebook_auth_input', description: 'Securely fill a Facebook email or password field using VM environment secrets. The secret value is never returned to the model.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['email','password'] }, selector: { type: 'string' } }, required: ['kind','selector'] } } },
  { type: 'function', function: { name: 'facebook_otp_get', description: 'Securely check whether the configured Facebook OTP endpoint currently has a numeric OTP. The OTP itself is never returned to the model.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'facebook_otp_input', description: 'Securely retrieve the current OTP from the VM-configured endpoint and enter it into the visible Facebook OTP field. The OTP itself is never returned to the model.', parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } } },
  { type: 'function', function: { name: 'facebook_auth_status', description: 'Check whether the current persistent Facebook browser page appears authenticated.', parameters: { type: 'object', properties: {} } } }
];

async function providerChat(messages, availableTools = tools) {
  let lastError;
  for (const model of MODELS) {
    try {
      const r = await fetch(`${BASE_URL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` }, body: JSON.stringify({ model, messages, tools: availableTools, tool_choice: 'auto', max_tokens: 1800, temperature: 0.2 }) });
      const text = await r.text();
      if (!r.ok) { lastError = new Error(`AI provider ${r.status} using ${model}: ${text.slice(0, 1000)}`); continue; }
      const result = JSON.parse(text);
      if (!result?.choices?.[0]?.message) throw new Error(`Invalid AI response from ${model}`);
      return result;
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error('All AI models failed');
}

async function executeTool(name, args) {
  switch (name) {
    case 'browser_navigate': return browserNavigate(args.url);
    case 'browser_snapshot': return browserSnapshot();
    case 'browser_click': return browserClick(args.selector);
    case 'browser_type': return browserType(args.selector, args.text);
    case 'browser_press': return browserPress(args.selector, args.key);
    case 'browser_wait': return browserWait(args.ms);
    case 'browser_close': return browserClose();
    case 'web_fetch': return webFetch(args.url);
    case 'qualify_lead': return JSON.stringify(args);
    case 'facebook_authenticate': return JSON.stringify(await runFacebookAuthLLM(await ensureBrowser(), providerChat));
    case 'facebook_auth_input': return facebookAuthInput(args.kind, args.selector);
    case 'facebook_otp_get': return facebookOtpGet();
    case 'facebook_otp_input': return facebookOtpInput(args.selector);
    case 'facebook_auth_status': return facebookAuthStatus();
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleChat(payload) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...(Array.isArray(payload.messages) ? payload.messages : []), ...(payload.message ? [{ role: 'user', content: String(payload.message) }] : [])];
  if (!messages.some(m => m.role === 'user')) throw new Error('message or messages is required');
  for (let round = 0; round < 12; round++) {
    const result = await providerChat(messages);
    const msg = result.choices[0].message;
    messages.push(msg);
    if (!msg.tool_calls?.length) return result;
    for (const call of msg.tool_calls) {
      let output;
      try { output = await executeTool(call.function.name, JSON.parse(call.function.arguments || '{}')); }
      catch (e) { output = JSON.stringify({ ok: false, error: e.message }); }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }
  throw new Error('Tool-call loop exceeded safety limit');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      let browser = false; try { await ensureBrowser(); browser = true; } catch {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'travel-sales-agent', model: MODELS[0], provider: PROVIDER, browser: browser ? 'ready' : 'unavailable', profile: PROFILE_DIR })); return;
    }
    if (req.method === 'POST' && req.url === '/chat') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const result = await handleChat(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); return;
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
});

let shutdownPromise = null;
async function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    console.log(`Received ${signal}; shutting down travel sales agent...`);
    await new Promise(resolve => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      setTimeout(resolve, 5000).unref();
    });
    const context = browserContext;
    browserContext = null;
    browserPage = null;
    browserInitPromise = null;
    if (context) {
      const closePromise = context.close().catch(err => console.error('Browser close error:', err.message));
      await Promise.race([closePromise, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    console.log('Travel sales agent shutdown complete.');
  })();
  await shutdownPromise;
  process.exit(0);
}

process.once('SIGTERM', () => { shutdown('SIGTERM').catch(err => { console.error(err); process.exit(1); }); });
process.once('SIGINT', () => { shutdown('SIGINT').catch(err => { console.error(err); process.exit(1); }); });

server.listen(PORT, '127.0.0.1', () => console.log(`Travel sales agent listening on http://127.0.0.1:${PORT}`));
