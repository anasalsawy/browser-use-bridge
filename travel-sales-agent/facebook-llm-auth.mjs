const AUTH_TOOLS = [
  { type: 'function', function: { name: 'browser_navigate', description: 'Open a URL in the current persistent browser.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_snapshot', description: 'Inspect the current visible page AND its interactive controls. Use this before choosing selectors.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_click', description: 'Click a visible element identified from the current snapshot. Prefer the exact selector supplied by the snapshot.', parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } } },
  { type: 'function', function: { name: 'browser_press', description: 'Press a key on a visible element identified from the current snapshot.', parameters: { type: 'object', properties: { selector: { type: 'string' }, key: { type: 'string' } }, required: ['selector','key'] } } },
  { type: 'function', function: { name: 'facebook_auth_input', description: 'Securely fill the observed Facebook email or password field using VM credentials. Never expose the secret.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['email','password'] }, selector: { type: 'string' } }, required: ['kind','selector'] } } },
  { type: 'function', function: { name: 'facebook_otp_get', description: 'Check whether the configured VM OTP relay has a numeric OTP without returning it. Use only AFTER SMS/text verification has been selected.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'facebook_otp_input', description: 'Securely retrieve the current OTP and fill the observed Facebook OTP field. Use only AFTER SMS/text verification has been selected. Never expose the OTP.', parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } } },
  { type: 'function', function: { name: 'facebook_auth_status', description: 'Verify the current Facebook authentication state.', parameters: { type: 'object', properties: {} } } }
];

function visibleSelectorFor(tag, text, index) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (clean) {
    const escaped = clean.replace(/"/g, '\\"');
    return `${tag}:has-text("${escaped}")`;
  }
  return `${tag}:visible:nth-of-type(${index + 1})`;
}

export async function runFacebookAuthLLM(page, providerChat) {
  const secret = (name) => { if (!process.env[name]) throw new Error(`${name} is not configured on the VM`); return process.env[name]; };
  let smsSelected = false;

  const interactive = async () => {
    const items = [];
    const selectors = ['button', 'a', '[role="button"]', 'input', 'label'];
    for (const tag of selectors) {
      const loc = page.locator(`${tag}:visible`);
      const count = Math.min(await loc.count().catch(() => 0), 40);
      for (let i = 0; i < count; i++) {
        const el = loc.nth(i);
        const type = await el.getAttribute('type').catch(() => null);
        const aria = await el.getAttribute('aria-label').catch(() => null);
        const name = await el.getAttribute('name').catch(() => null);
        const placeholder = await el.getAttribute('placeholder').catch(() => null);
        const text = (await el.innerText({ timeout: 1500 }).catch(() => '')).trim();
        const value = await el.getAttribute('value').catch(() => null);
        items.push({ tag, type, aria_label: aria, name, placeholder, text: text.slice(0, 160), value: value && !/password|otp|code|token/i.test(type || '') ? value.slice(0, 80) : undefined, selector: visibleSelectorFor(tag, aria || text || placeholder || name, i) });
      }
    }
    return items.slice(0, 120);
  };

  const snapshot = async () => ({ ok: true, url: page.url(), title: await page.title(), text: (await page.locator('body').innerText({ timeout: 15000 }).catch(() => '')).slice(0, 12000), interactive: await interactive() });

  const status = async () => {
    const s = await snapshot();
    const blob = `${s.url}\n${s.title}\n${s.text}`;
    const checkpoint = /checkpoint|confirm your identity|security check/i.test(blob);
    const captcha = /captcha|recaptcha|hcaptcha/i.test(blob);
    const sms_option = /sms|text message|text me|send (a )?code to (?:your )?phone|phone.*code/i.test(blob) || s.interactive.some(x => /sms|text message|text me|send.*code.*phone|phone.*code/i.test(`${x.aria_label || ''} ${x.text || ''} ${x.value || ''}`));
    const loginUrl = /facebook\.com/i.test(s.url) && /\/login(?:[/?#]|$)/i.test(s.url);
    const emailField = await page.locator('input[name="email"], input[type="email"]').filter({ visible: true }).count().catch(() => 0);
    const passwordField = await page.locator('input[name="pass"], input[type="password"]').filter({ visible: true }).count().catch(() => 0);
    const loginForm = emailField > 0 || passwordField > 0;
    const cookies = await page.context().cookies('https://www.facebook.com').catch(() => []);
    const hasUserCookie = cookies.some(c => c.name === 'c_user' && Boolean(c.value));
    const hasSessionCookie = cookies.some(c => c.name === 'xs' && Boolean(c.value));
    const authenticated = /facebook\.com/i.test(s.url) && hasUserCookie && hasSessionCookie && !loginUrl && !loginForm && !checkpoint && !captcha;
    return { ok: true, authenticated, checkpoint, captcha, sms_option, sms_selected: smsSelected, login_form: loginForm, cookie_session: hasUserCookie && hasSessionCookie, url: s.url, title: s.title };
  };

  const otp = async () => {
    if (!smsSelected) throw new Error('SMS/text verification has not been selected yet; inspect the verification choices and select SMS/text first');
    const url = process.env.FB_OTP_GET_URL || process.env.FB_OTP_URL;
    const token = process.env.FB_OTP_GET_TOKEN || process.env.FB_OTP_TOKEN;
    if (!url || !token) throw new Error('Facebook OTP GET relay is not configured');
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json,text/plain,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    if (!r.ok) throw new Error(`OTP relay returned HTTP ${r.status}`);
    let code = '';
    try { const d = JSON.parse(text); code = String(d.code ?? d.otp ?? d.token ?? d.value ?? '').trim(); } catch { code = text.trim(); }
    if (!/^\d{4,8}$/.test(code)) throw new Error('OTP relay did not return a numeric OTP');
    return code;
  };

  const before = await status();
  if (!before.authenticated && !before.checkpoint) await page.goto('https://www.facebook.com/login/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  const messages = [
    { role: 'system', content: 'You are ONLY the Facebook authentication sub-agent. You MUST operate the CURRENT persistent browser page with tool calls; prose-only responses are invalid. First call browser_snapshot. If already authenticated, call facebook_auth_status and stop. If login is needed, use the snapshot interactive selectors and securely fill email/password with facebook_auth_input, submit using an observed visible control or Enter, then inspect the result. IMPORTANT: if Facebook presents a verification/checkpoint screen with multiple verification methods, inspect the visible choices and SELECT SMS/TEXT MESSAGE verification when it is available. Do NOT select authenticator-app verification when SMS/text is available. Use the exact selector for the SMS/text option from browser_snapshot. After selecting SMS/text, wait for the code request to complete, call facebook_otp_get to confirm the configured VM relay has a numeric code, then call facebook_otp_input on the observed OTP field and continue. Never request, expose, repeat, or infer credentials or OTP values. Do not stop merely because the page contains the word checkpoint: a verification checkpoint is actionable when an SMS/text option is visible. Stop only for a CAPTCHA or genuinely human-only identity challenge with no usable SMS verification path. Finish with facebook_auth_status.' },
    { role: 'user', content: 'Authenticate Facebook now. Begin by calling browser_snapshot. If a verification method screen appears, choose SMS/text verification when available. Every response must contain a tool call.' }
  ];

  for (let round = 0; round < 24; round++) {
    const current = await status();
    if (current.authenticated) return current;
    if (current.captcha) return current;
    if (current.checkpoint && !current.sms_option) return current;

    const result = await providerChat(messages, AUTH_TOOLS);
    const msg = result.choices?.[0]?.message;
    if (!msg) throw new Error('LLM returned no message');
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      const retry = await status();
      if (retry.authenticated) return retry;
      if (retry.captcha) return retry;
      if (retry.checkpoint && !retry.sms_option) return retry;
      messages.push({ role: 'user', content: 'INVALID RESPONSE: you did not call a tool. Call browser_snapshot or the next required browser/authentication tool NOW. Do not answer with prose or reasoning.' });
      continue;
    }

    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments || '{}');
      let output;
      try {
        switch (call.function.name) {
          case 'browser_navigate': await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 }); output = await snapshot(); break;
          case 'browser_snapshot': output = await snapshot(); break;
          case 'browser_click': {
            const selectorText = String(args.selector || '');
            if (/sms|text message|text me|phone.*code|code.*phone/i.test(selectorText)) smsSelected = true;
            await page.locator(args.selector).filter({ visible: true }).first().click({ timeout: 20000 });
            await page.waitForTimeout(1200);
            const afterClick = await snapshot();
            const afterBlob = `${afterClick.text} ${afterClick.interactive.map(x => `${x.aria_label || ''} ${x.text || ''}`).join(' ')}`;
            if (smsSelected && !/sms|text message|text me|phone.*code|code.*phone/i.test(afterBlob)) smsSelected = true;
            output = afterClick;
            break;
          }
          case 'browser_press': await page.locator(args.selector).filter({ visible: true }).first().press(args.key, { timeout: 20000 }); await page.waitForTimeout(1200); output = await snapshot(); break;
          case 'facebook_auth_input': {
            const value = secret(args.kind === 'email' ? 'FB_EMAIL' : 'FB_PASSWORD');
            await page.locator(args.selector).filter({ visible: true }).first().fill(value, { timeout: 20000 });
            output = { ok: true, kind: args.kind, filled: true }; break;
          }
          case 'facebook_otp_get': await otp(); output = { ok: true, otp_available: true }; break;
          case 'facebook_otp_input': { const code = await otp(); await page.locator(args.selector).filter({ visible: true }).first().fill(code, { timeout: 20000 }); output = { ok: true, otp_entered: true }; break; }
          case 'facebook_auth_status': output = await status(); break;
          default: throw new Error(`Tool not allowed in Facebook auth sub-agent: ${call.function.name}`);
        }
      } catch (e) { output = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }
  throw new Error('Facebook LLM authentication exceeded safety loop limit');
}
