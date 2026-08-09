import { chromium } from 'playwright';

const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || '/home/azureuser/.travel-sales-agent/chromium-profile';
const LOGIN_URL = process.env.FB_LOGIN_URL || 'https://www.facebook.com/login/';
const API_KEY = process.env.HF_TOKEN;
const BASE_URL = (process.env.AI_BASE_URL || 'https://router.huggingface.co/v1').replace(/\/$/, '');
const MODELS = [process.env.AI_MODEL || 'openai/gpt-oss-120b:fastest', 'openai/gpt-oss-20b:fastest', 'deepseek-ai/DeepSeek-R1:fastest'];

function required(name, value) { if (!value) throw new Error(`${name} is not configured`); }
async function snapshot(page) { return { ok: true, url: page.url(), title: await page.title(), text: (await page.locator('body').innerText({ timeout: 15000 }).catch(() => '')).slice(0, 30000) }; }
async function authStatus(page) { const s = await snapshot(page); const loginPage = /facebook\.com/i.test(s.url) && (/\/login(?:[/?#]|$)/i.test(s.url) || /log in|create new account/i.test(s.text.slice(0, 8000))); const checkpoint = /checkpoint|confirm your identity|security check|captcha/i.test(`${s.url}\n${s.text}`); return { ok: true, authenticated: /facebook\.com/i.test(s.url) && !loginPage && !checkpoint, checkpoint, url: s.url, title: s.title }; }
async function secureFill(page, kind, selector) { const envName = kind === 'email' ? 'FB_EMAIL' : 'FB_PASSWORD'; required(envName, process.env[envName]); const loc = page.locator(selector).filter({ visible: true }).first(); await loc.fill(process.env[envName], { timeout: 20000 }); return { ok: true, kind, filled: true }; }
async function secureOtpFill(page, selector) { required('FB_OTP_URL', process.env.FB_OTP_URL); required('FB_OTP_TOKEN', process.env.FB_OTP_TOKEN); const response = await fetch(process.env.FB_OTP_URL, { headers: { authorization: `Bearer ${process.env.FB_OTP_TOKEN}`, accept: 'application/json,text/plain,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }); const body = await response.text(); if (!response.ok) throw new Error(`OTP endpoint HTTP ${response.status}`); let code = ''; try { const data = JSON.parse(body); code = String(data.code ?? data.otp ?? data.token ?? data.value ?? '').trim(); } catch { code = body.trim(); } if (!/^\d{4,8}$/.test(code)) throw new Error('OTP endpoint did not return a numeric OTP'); await page.locator(selector).filter({ visible: true }).first().fill(code, { timeout: 20000 }); return { ok: true, otp_entered: true }; }

const tools = [
  { type: 'function', function: { name: 'browser_navigate', description: 'Navigate the persistent Facebook browser.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_snapshot', description: 'Inspect visible page text, URL and title before choosing actions.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_click', description: 'Click a visible element using a selector observed in the snapshot.', parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } } },
  { type: 'function', function: { name: 'browser_press', description: 'Press a key on a visible element using an observed selector.', parameters: { type: 'object', properties: { selector: { type: 'string' }, key: { type: 'string' } }, required: ['selector','key'] } } },
  { type: 'function', function: { name: 'facebook_auth_input', description: 'Securely fill Facebook email/password. Secret is never returned to the model.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['email','password'] }, selector: { type: 'string' } }, required: ['kind','selector'] } } },
  { type: 'function', function: { name: 'facebook_otp_input', description: 'Securely fetch OTP from the configured endpoint and fill the visible Facebook OTP field. OTP is never returned to the model.', parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } } },
  { type: 'function', function: { name: 'facebook_auth_status', description: 'Check current Facebook authentication state.', parameters: { type: 'object', properties: {} } } }
];

async function llm(messages) { required('HF_TOKEN', API_KEY); let lastError; for (const model of MODELS) { try { const r = await fetch(`${BASE_URL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` }, body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', max_tokens: 1800, temperature: 0.1 }) }); const text = await r.text(); if (!r.ok) { lastError = new Error(`AI provider HTTP ${r.status} using ${model}: ${text.slice(0, 800)}`); continue; } const data = JSON.parse(text); if (!data?.choices?.[0]?.message) throw new Error(`Invalid AI response using ${model}`); return data.choices[0].message; } catch (e) { lastError = e; } } throw lastError || new Error('All AI models failed'); }

export async function runFacebookLogin() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true, viewport: { width: 1440, height: 1000 }, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const page = context.pages()[0] || await context.newPage();
  const messages = [
    { role: 'system', content: `You are the LLM browser worker responsible only for authenticating the persistent Facebook session for Your Travel Agent. Inspect the live page first. Never use fixed login selectors without observing them. Use facebook_auth_input for secrets and facebook_otp_input for OTP; never request, print, or repeat secret values. If already authenticated, stop. If login is needed, navigate to ${LOGIN_URL}, snapshot, identify visible email/password controls, fill them securely, submit with an observed visible control or Enter, inspect the result, and handle OTP only when Facebook visibly requests it. Finish by verifying facebook_auth_status. If Facebook shows CAPTCHA, checkpoint, identity confirmation, or another human-only challenge, stop and report blocked authentication.` },
    { role: 'user', content: 'Authenticate Facebook now. Begin with browser_snapshot. Do not expose credentials or OTP.' }
  ];
  try {
    for (let round = 0; round < 14; round++) {
      const message = await llm(messages); messages.push(message);
      if (!message.tool_calls?.length) { const result = await authStatus(page); if (result.authenticated) return result; throw new Error(`LLM stopped before authentication completed: ${message.content || 'no tool call'}`); }
      for (const call of message.tool_calls) {
        let output;
        try {
          const args = JSON.parse(call.function.arguments || '{}');
          switch (call.function.name) {
            case 'browser_navigate': await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 }); output = await snapshot(page); break;
            case 'browser_snapshot': output = await snapshot(page); break;
            case 'browser_click': await page.locator(args.selector).filter({ visible: true }).first().click({ timeout: 20000 }); await page.waitForTimeout(800); output = await snapshot(page); break;
            case 'browser_press': await page.locator(args.selector).filter({ visible: true }).first().press(args.key, { timeout: 20000 }); await page.waitForTimeout(800); output = await snapshot(page); break;
            case 'facebook_auth_input': output = await secureFill(page, args.kind, args.selector); break;
            case 'facebook_otp_input': output = await secureOtpFill(page, args.selector); break;
            case 'facebook_auth_status': output = await authStatus(page); break;
            default: throw new Error(`Unknown tool ${call.function.name}`);
          }
        } catch (e) { output = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
      }
    }
    throw new Error('LLM Facebook login tool loop exceeded safety limit');
  } finally { await context.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) { runFacebookLogin().then((result) => { console.log(JSON.stringify(result)); process.exit(result.authenticated ? 0 : 1); }).catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }); }
