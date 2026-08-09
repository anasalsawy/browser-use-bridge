import http from 'node:http';

const PORT = Number(process.env.TRAVEL_AGENT_PORT || 8890);
const API_KEY = process.env.HF_TOKEN;
const BASE_URL = (process.env.AI_BASE_URL || 'https://router.huggingface.co/v1').replace(/\/$/, '');
const MODELS = [process.env.AI_MODEL || 'openai/gpt-oss-120b:fastest', 'openai/gpt-oss-20b:fastest', 'deepseek-ai/DeepSeek-R1:fastest'];
const PROVIDER = 'huggingface';
const VM_SHELL_URL = process.env.VM_SHELL_URL || 'http://127.0.0.1:8800/mcp';
const VM_EXEC_TOKEN = process.env.VM_EXEC_TOKEN;
const SYSTEM_PROMPT = `You are the autonomous travel sales agent for Your Travel Agent. You qualify leads, research travel, communicate professionally, and operate the connected Linux VM browser when needed. Never invent flight availability, prices, bookings, payment receipt, credentials, or customer data. Use browser/VM tools only for legitimate travel-business work. Do not expose secrets. Before any consequential purchase/payment action, require explicit customer authorization and never enter card/CVV/OTP secrets yourself.`;

if (!API_KEY) { console.error('HF_TOKEN is required'); process.exit(1); }
if (!VM_EXEC_TOKEN) { console.error('VM_EXEC_TOKEN is required'); process.exit(1); }

const tools = [
  { type: 'function', function: {
    name: 'vm_exec',
    description: 'Execute a bounded shell command on the connected Linux VM. Use this for browser/Chromium diagnostics and approved travel-agent automation. Do not use destructive commands, credential dumping, or payment-secret handling.',
    parameters: { type: 'object', properties: {
      command: { type: 'string', description: 'A non-destructive command for browser/travel automation.' },
      cwd: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000 }
    }, required: ['command'] }
  }},
  { type: 'function', function: {
    name: 'qualify_lead',
    description: 'Extract known travel requirements from a lead message.',
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
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', max_tokens: 1600, temperature: 0.2 })
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

async function vmExec(command, cwd, timeout_ms) {
  const denied = /(^|[;&|])\s*(rm|shutdown|reboot|mkfs|dd|passwd|useradd|userdel|curl\s+.*\|\s*(sh|bash)|wget\s+.*\|\s*(sh|bash))\b|(/etc/shadow|/etc/passwd\b.*>|authorized_keys\s*[:=])/i;
  if (denied.test(command)) throw new Error('Command rejected by VM safety policy');
  const r = await fetch(VM_SHELL_URL, {
    method: 'POST', headers: { authorization: `Bearer ${VM_EXEC_TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: 'vm_exec', arguments: { command, cwd, timeout_ms } } })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`VM shell ${r.status}: ${text.slice(0, 1000)}`);
  return text.slice(0, 12000);
}

async function handleChat(payload) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(Array.isArray(payload.messages) ? payload.messages : []),
    ...(payload.message ? [{ role: 'user', content: String(payload.message) }] : [])
  ];
  if (!messages.some(m => m.role === 'user')) throw new Error('message or messages is required');

  for (let round = 0; round < 6; round++) {
    const result = await providerChat(messages);
    const msg = result.choices[0].message;
    messages.push(msg);
    if (!msg.tool_calls?.length) return result;

    for (const call of msg.tool_calls) {
      let output;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        if (call.function.name === 'vm_exec') output = await vmExec(args.command, args.cwd, args.timeout_ms);
        else if (call.function.name === 'qualify_lead') output = JSON.stringify(args);
        else output = 'Unknown tool';
      } catch (e) { output = JSON.stringify({ ok: false, error: e.message }); }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }
  throw new Error('Tool-call loop exceeded safety limit');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'travel-sales-agent', model: MODELS[0], provider: PROVIDER, browser_bridge: !!VM_EXEC_TOKEN })); return;
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
