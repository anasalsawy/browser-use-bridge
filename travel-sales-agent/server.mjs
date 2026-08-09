import http from 'node:http';
import { chromium } from 'playwright';

const PORT = Number(process.env.TRAVEL_AGENT_PORT || 8890);
const API_KEY = process.env.HF_TOKEN;
const BASE_URL = (process.env.AI_BASE_URL || 'https://router.huggingface.co/v1').replace(/\/$/, '');
const MODELS = [process.env.AI_MODEL || 'openai/gpt-oss-120b:fastest', 'openai/gpt-oss-20b:fastest', 'deepseek-ai/DeepSeek-R1:fastest'];
const PROVIDER = 'huggingface';
const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || '/home/azureuser/.travel-sales-agent/chromium-profile';
const SYSTEM_PROMPT = `You are the autonomous travel sales agent for Your Travel Agent. Your job is to do real company work, not role-play. Qualify leads, research travel, communicate professionally, maintain context, and use the connected headless Chromium browser to perform legitimate web work. Never invent flight availability, prices, bookings, payment receipt, credentials, or customer data. Do not expose secrets. Do not enter card numbers, CVVs, passwords, or OTP secrets into arbitrary tools. Before any consequential purchase/payment action, require explicit customer authorization. Use the browser tools directly; do not ask for or depend on a shell bridge. When a website requires login, use the already-authenticated persistent browser profile and report clearly if authentication is missing. Be truthful about every action completed.`;

if (!API_KEY) { console.error('HF_TOKEN is required'); process.exit(1); }

let browserContext = null;
let browserPage = null;

async function ensureBrowser() {
  if (browserContext && browserPage) return browserPage;
  browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  browserPage = browserContext.pages()[0] || await browserContext.newPage();
  return browserPage;
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
  await page.locator(selector).first().click({ timeout: 20000 });
  await page.waitForTimeout(500);
  return JSON.stringify({ ok: true, url: page.url(), title: await page.title() });
}

async function browserType(selector, text) {
  if (/(password|passwd|cvv|cvc|card.?number|otp|one.?time|verification.?code)/i.test(selector)) {
    throw new Error('Secret-entry selectors are blocked; use the platform authentication/session flow instead.');
  }
  const page = await ensureBrowser();
  await page.locator(selector).first().fill(String(text), { timeout: 20000 });
  return JSON.stringify({ ok: true });
}

async function browserPress(selector, key) {
  const page = await ensureBrowser();
  await page.locator(selector).first().press(key, { timeout: 20000 });
  await page.waitForTimeout(500);
  return JSON.stringify({ ok: true, url: page.url(), title: await page.title() });
}

async function browserWait(ms) {
  const page = await ensureBrowser();
  await page.waitForTimeout(Math.min(Math.max(Number(ms) || 1000, 100), 30000));
  return JSON.stringify({ ok: true, url: page.url(), title: await page.title() });
}

async function browserClose() {
  if (browserContext) await browserContext.close();
  browserContext = null;
  browserPage = null;
  return JSON.stringify({ ok: true });
}

async function webFetch(url) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
  const r = await fetch(u, { redirect: 'follow' });
  const text = await r.text();
  return JSON.stringify({ ok: r.ok, status: r.status, url: r.url, body: text.slice(0, 20000) });
}

const tools = [
  { type: 'function', function: {
    name: 'browser_navigate', description: 'Open a URL in the persistent headless Chromium browser.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  }},
  { type: 'function', function: {
    name: 'browser_snapshot', description: 'Read the visible text and current URL/title from the browser page.',
    parameters: { type: 'object', properties: {} }
  }},
  { type: 'function', function: {
    name: 'browser_click', description: 'Click the first matching CSS selector in the browser.',
    parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] }
  }},
  { type: 'function', function: {
    name: 'browser_type', description: 'Fill a non-secret form field in the browser.',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector','text'] }
  }},
  { type: 'function', function: {
    name: 'browser_press', description: 'Press a keyboard key on a matching browser element.',
    parameters: { type: 'object', properties: { selector: { type: 'string' }, key: { type: 'string' } }, required: ['selector','key'] }
  }},
  { type: 'function', function: {
    name: 'browser_wait', description: 'Wait briefly for a page to update.',
    parameters: { type: 'object', properties: { ms: { type: 'integer', minimum: 100, maximum: 30000 } }, required: ['ms'] }
  }},
  { type: 'function', function: {
    name: 'browser_close', description: 'Close the browser context while retaining the persistent profile on disk.',
    parameters: { type: 'object', properties: {} }
  }},
  { type: 'function', function: {
    name: 'web_fetch', description: 'Fetch a public HTTP(S) URL for travel research or an approved API endpoint.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  }},
  { type: 'function', function: {
    name: 'qualify_lead', description: 'Extract known travel requirements from a lead message and identify missing requirements.',
    parameters: { type: 'object', properties: {
      origin: { type: 'string' }, destination: { type: 'string' }, dates: { type: 'string' },
      passengers: { type: 'string' }, cabin: { type: 'string' }, trip_type: { type: 'string' },
      missing: { type: 'array', items: { type: 'string' } }
    }, required: ['missing'] }
  }}
];

async function providerChat(messages) {
  let lastError;
  for (const model of MODELS) {
    try {
      const r = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', max_tokens: 1800, temperature: 0.2 })
      });
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
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleChat(payload) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(Array.isArray(payload.messages) ? payload.messages : []),
    ...(payload.message ? [{ role: 'user', content: String(payload.message) }] : [])
  ];
  if (!messages.some(m => m.role === 'user')) throw new Error('message or messages is required');

  for (let round = 0; round < 8; round++) {
    const result = await providerChat(messages);
    const msg = result.choices[0].message;
    messages.push(msg);
    if (!msg.tool_calls?.length) return result;
    for (const call of msg.tool_calls) {
      let output;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        output = await executeTool(call.function.name, args);
      } catch (e) { output = JSON.stringify({ ok: false, error: e.message }); }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }
  throw new Error('Tool-call loop exceeded safety limit');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      let browser = false;
      try { await ensureBrowser(); browser = true; } catch {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'travel-sales-agent', model: MODELS[0], provider: PROVIDER, browser: browser ? 'ready' : 'unavailable', profile: PROFILE_DIR })); return;
    }
    if (req.method === 'POST' && req.url === '/chat') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const result = await handleChat(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); return;
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Travel sales agent listening on http://127.0.0.1:${PORT}`));
