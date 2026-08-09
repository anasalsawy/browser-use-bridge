import http from 'node:http';

const PORT = Number(process.env.TRAVEL_AGENT_PORT || 8890);
const API_KEY = process.env.AI_API_KEY;
const BASE_URL = (process.env.AI_BASE_URL || 'https://api.featherless.ai/v1').replace(/\/$/, '');
const MODEL = process.env.AI_MODEL || 'Qwen/Qwen3-32B';
const SYSTEM_PROMPT = `You are an elite travel sales specialist for Your Travel Agent. Qualify flight leads, gather origin, destination, dates, passenger count, cabin, and trip type. Be warm, professional, transparent, and never invent flight availability, prices, bookings, payment receipt, or credentials. The business targets very competitive fares; only claim a specific discount when supported by an actual quote. For a new lead, ask only the missing qualification questions and keep the conversation concise.`;

if (!API_KEY) {
  console.error('AI_API_KEY is required');
  process.exit(1);
}

async function featherless(messages, tools) {
  const body = { model: MODEL, messages, max_tokens: 1200, temperature: 0.3 };
  if (tools?.length) body.tools = tools;
  const r = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`AI provider ${r.status}: ${text.slice(0, 1000)}`);
  return JSON.parse(text);
}

const tools = [{
  type: 'function',
  function: {
    name: 'qualify_lead',
    description: 'Extract the travel requirements known so far from a lead message.',
    parameters: {
      type: 'object',
      properties: {
        origin: { type: 'string' }, destination: { type: 'string' }, dates: { type: 'string' },
        passengers: { type: 'string' }, cabin: { type: 'string' }, trip_type: { type: 'string' },
        missing: { type: 'array', items: { type: 'string' } }
      },
      required: ['missing']
    }
  }
}];

async function handleChat(payload) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(Array.isArray(payload.messages) ? payload.messages : []),
    ...(payload.message ? [{ role: 'user', content: String(payload.message) }] : [])
  ];
  if (!messages.some(m => m.role === 'user')) throw new Error('message or messages is required');
  const result = await featherless(messages, tools);
  return result;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'travel-sales-agent', model: MODEL, provider: 'featherless' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/chat') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const result = await handleChat(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Travel sales agent listening on http://127.0.0.1:${PORT}`));
