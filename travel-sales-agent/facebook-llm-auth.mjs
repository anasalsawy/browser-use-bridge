export async function runFacebookAuthLLM(page, providerChat) {
  const tools = [
    { type: 'function', function: { name: 'browser_navigate', description: 'Navigate the current persistent browser page.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
    { type: 'function', function: { name: 'browser_snapshot', description: 'Inspect the current visible Facebook page. Return only non-secret visible text.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'browser_click', description: 'Click a visible element selected from the current snapshot.', parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } } },
    { type: 'function', function: { name: 'browser_press', description: 'Press a key on a visible element.', parameters: { type: 'object', properties: { selector: { type: 'string' }, key: { type: 'string' } }, required: ['selector','key'] } } },
    { type: 'function', function: { name: 'facebook_auth_input', description: 'Securely fill Facebook email or password from VM environment secrets. Never returns the secret.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['email','password'] }, selector: { type: 'string' } }, required: ['kind','selector'] } } },
    { type: 'function', function: { name: 'facebook_otp_get', description: 'Securely check the configured OTP GET endpoint. Never returns the OTP.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'facebook_otp_input', description: 'Securely fetch the current OTP and enter it into the visible OTP field. Never returns the OTP.', parameters: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } } },
    { type: 'function', function: { name: 'facebook_auth_status', description: 'Verify whether Facebook is authenticated in the current persistent browser.', parameters: { type: 'object', properties: {} } } }
  ];

  const secret = (name) => { if (!process.env[name]) throw new Error(`${name} is not configured on the VM`); return process.env[name]; };
  const snapshot = async () => ({ ok: true, url: page.url(), title: await page.title(), text: (await page.locator('body').innerText({ timeout: 15000 }).catch(() => '')).slice(0, 12000) });
  const status = async () => {
    const s = await snapshot();
    const blob = `${s.url}\n${s.title}\n${s.text}`;
    const checkpoint = /checkpoint|confirm your identity|security check|captcha/i.test(blob);
    const login = /facebook\.com/i.test(s.url) && (/\/login(?:[/?#]|$)/i.test(s.url) || /log in|create new account/i.test(s.text.slice(0, 5000)));
    return { ok: true, authenticated: /facebook\.com/i.test(s.url) && !login && !checkpoint, checkpoint, url: s.url, title: s.title };
  };
  const otp = async () => {
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
  const messages = [
    { role: 'system', content: 'You are the Facebook authentication sub-agent for a travel sales company. Operate the CURRENT persistent browser page using the tools. First inspect it. If already authenticated, stop. If login is needed, navigate to Facebook login, inspect the live page, identify the visible email/password fields from the snapshot, securely fill them with facebook_auth_input, submit using a visible control or Enter, inspect the result, and only if Facebook visibly requests a verification code use facebook_otp_get then facebook_otp_input. Never request, expose, repeat, or infer credentials or OTP values. If Facebook presents CAPTCHA, checkpoint, identity confirmation, or another human-only challenge, stop and report blocked. Finish with facebook_auth_status.' },
    { role: 'user', content: 'Authenticate Facebook now using the current persistent browser. Begin with browser_snapshot.' }
  ];
  for (let round = 0; round < 12; round++) {
    const result = await providerChat([...messages, { role: 'system', content: JSON.stringify({ tools }) }]);
    const msg = result.choices?.[0]?.message;
    if (!msg) throw new Error('LLM returned no message');
    messages.push(msg);
    if (!msg.tool_calls?.length) {
      const s = await status();
      if (s.authenticated) return s;
      throw new Error(`LLM stopped before Facebook authentication completed: ${msg.content || 'no tool call'}`);
    }
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments || '{}');
      let output;
      try {
        switch (call.function.name) {
          case 'browser_navigate': await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 }); output = await snapshot(); break;
          case 'browser_snapshot': output = await snapshot(); break;
          case 'browser_click': await page.locator(args.selector).filter({ visible: true }).first().click({ timeout: 20000 }); await page.waitForTimeout(800); output = await snapshot(); break;
          case 'browser_press': await page.locator(args.selector).filter({ visible: true }).first().press(args.key, { timeout: 20000 }); await page.waitForTimeout(800); output = await snapshot(); break;
          case 'facebook_auth_input': {
            const value = secret(args.kind === 'email' ? 'FB_EMAIL' : 'FB_PASSWORD');
            await page.locator(args.selector).filter({ visible: true }).first().fill(value, { timeout: 20000 });
            output = { ok: true, kind: args.kind, filled: true }; break;
          }
          case 'facebook_otp_get': await otp(); output = { ok: true, otp_available: true }; break;
          case 'facebook_otp_input': { const code = await otp(); await page.locator(args.selector).filter({ visible: true }).first().fill(code, { timeout: 20000 }); output = { ok: true, otp_entered: true }; break; }
          case 'facebook_auth_status': output = await status(); break;
          default: throw new Error(`Unknown Facebook auth tool ${call.function.name}`);
        }
      } catch (e) { output = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }
  throw new Error('Facebook LLM authentication exceeded safety loop limit');
}
