// ─── Sunday API — Cloudflare Worker ───────────────────────────────────────
//
// Proxies the browser app's chat requests to the Anthropic API, holding the
// API key as a Worker secret so users never have to paste their own. Also
// acts as state store for church roster/set data via Cloudflare KV.
//
// Endpoints:
//   GET  /                      → friendly health page
//   GET  /health                → JSON status
//   POST /chat                  → Anthropic /v1/messages proxy
//   POST /church/new            → create a church record → { id, adminKey }
//   GET  /state?church=ID       → load church state (public, read-only)
//   POST /state?church=ID       → save church state (requires adminKey in body)
//   GET  /whatsapp/status       → { enabled: bool }
//   POST /whatsapp/send         → send one WhatsApp message via Twilio
//   POST /whatsapp/blast        → send personalised messages to a list
//
// Secrets (set with `wrangler secret put <NAME>`):
//   ANTHROPIC_API_KEY           (required)
//   TWILIO_ACCOUNT_SID          (required for WhatsApp)
//   TWILIO_AUTH_TOKEN           (required for WhatsApp)
//   TWILIO_FROM                 (required for WhatsApp — e.g. whatsapp:+14155238886)
//
// KV bindings (wrangler.toml):
//   SUNDAY_STATE                (church state store)

const DEFAULT_MODEL = 'claude-sonnet-4-6';

const ALLOWED_ORIGINS = new Set([
  'https://runworship.com',
  'https://www.runworship.com',
  'http://runworship.com',
  'http://www.runworship.com',
  'https://runchurch.com',
  'https://www.runchurch.com',
  'http://runchurch.com',
  'http://www.runchurch.com',
  'https://rm-selah.github.io',
  'http://localhost:8080',
  'http://localhost:8765',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8765',
]);

function corsHeadersFor(request) {
  var origin = request.headers.get('Origin') || '';
  var allowed = ALLOWED_ORIGINS.has(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

async function twilioSend(env, to, body) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM;
  const toNumber = to.startsWith('whatsapp:') ? to : 'whatsapp:' + to;
  const fromNumber = from.startsWith('whatsapp:') ? from : 'whatsapp:' + from;
  const params = new URLSearchParams();
  params.append('To', toNumber);
  params.append('From', fromNumber);
  params.append('Body', body);
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(sid + ':' + token),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    }
  );
  const data = await res.json();
  if (!res.ok) return { error: data.message || 'Twilio error', code: data.code };
  return { sid: data.sid, status: data.status };
}

function hasWhatsApp(env) {
  return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeadersFor(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── Root ──────────────────────────────────────────────────────────────────
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      return new Response(
        '<h2>☀ Sunday API</h2><p>Up and running. POST /chat to use.</p>',
        { headers: { ...cors, 'Content-Type': 'text/html' } }
      );
    }

    // ── Health ────────────────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        status: 'ok',
        model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        has_key: !!env.ANTHROPIC_API_KEY,
        whatsapp: hasWhatsApp(env),
        kv: !!env.SUNDAY_STATE,
      }, 200, cors);
    }

    // ── Create church ─────────────────────────────────────────────────────────
    // POST /church/new → { id, adminKey }
    if (request.method === 'POST' && url.pathname === '/church/new') {
      if (!env.SUNDAY_STATE) return json({ error: 'KV not configured' }, 500, cors);
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      const adminKey = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
      const initial = { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await env.SUNDAY_STATE.put(`church:${id}`, JSON.stringify(initial));
      await env.SUNDAY_STATE.put(`church:${id}:adminKey`, adminKey);
      return json({ id, adminKey }, 200, cors);
    }

    // ── Load state ────────────────────────────────────────────────────────────
    // GET /state?church=ID → full state blob (read-only, no auth required)
    if (request.method === 'GET' && url.pathname === '/state') {
      if (!env.SUNDAY_STATE) return json({ error: 'KV not configured' }, 500, cors);
      const churchId = url.searchParams.get('church');
      if (!churchId) return json({ error: 'church param required' }, 400, cors);
      const raw = await env.SUNDAY_STATE.get(`church:${churchId}`);
      if (!raw) return json({ error: 'Church not found' }, 404, cors);
      const state = JSON.parse(raw);
      return json(state, 200, cors);
    }

    // ── Save state ────────────────────────────────────────────────────────────
    // POST /state?church=ID  body: { adminKey, roster, team, songs, ... }
    if (request.method === 'POST' && url.pathname === '/state') {
      if (!env.SUNDAY_STATE) return json({ error: 'KV not configured' }, 500, cors);
      const churchId = url.searchParams.get('church');
      if (!churchId) return json({ error: 'church param required' }, 400, cors);

      const storedKey = await env.SUNDAY_STATE.get(`church:${churchId}:adminKey`);
      if (!storedKey) return json({ error: 'Church not found' }, 404, cors);

      let body;
      try { body = await request.json(); } catch(e) { return json({ error: 'Invalid JSON' }, 400, cors); }

      if (body.adminKey !== storedKey) return json({ error: 'Unauthorized' }, 403, cors);

      const toStore = { ...body, updatedAt: new Date().toISOString() };
      delete toStore.adminKey;
      await env.SUNDAY_STATE.put(`church:${churchId}`, JSON.stringify(toStore));
      return json({ ok: true, updatedAt: toStore.updatedAt }, 200, cors);
    }

    // ── Chat ──────────────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/chat') {
      const origin = request.headers.get('Origin');
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return json({ error: 'Origin not allowed' }, 403, cors);
      }
      if (!env.ANTHROPIC_API_KEY) {
        return json({ error: 'ANTHROPIC_API_KEY not set on the Worker' }, 500, cors);
      }
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: 'Invalid JSON' }, 400, cors); }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = body.system || '';
      const model = body.model || env.ANTHROPIC_MODEL || DEFAULT_MODEL;
      const maxTokens = body.max_tokens || 4096;
      if (messages.length === 0) return json({ error: 'messages array is required' }, 400, cors);
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
      });
    }

    // ── WhatsApp status ───────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/whatsapp/status') {
      return json({ enabled: hasWhatsApp(env) }, 200, cors);
    }

    // ── WhatsApp send ─────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/whatsapp/send') {
      const origin = request.headers.get('Origin');
      if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: 'Origin not allowed' }, 403, cors);
      if (!hasWhatsApp(env)) return json({ error: 'WhatsApp not configured on Worker' }, 503, cors);
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: 'Invalid JSON' }, 400, cors); }
      const { to, body: msgBody } = body;
      if (!to || !msgBody) return json({ error: '"to" and "body" are required' }, 400, cors);
      const result = await twilioSend(env, to, msgBody);
      return json(result, result.error ? 502 : 200, cors);
    }

    // ── WhatsApp blast ────────────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/whatsapp/blast') {
      const origin = request.headers.get('Origin');
      if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: 'Origin not allowed' }, 403, cors);
      if (!hasWhatsApp(env)) return json({ error: 'WhatsApp not configured on Worker' }, 503, cors);
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: 'Invalid JSON' }, 400, cors); }
      const recipients = Array.isArray(body.recipients) ? body.recipients : [];
      if (recipients.length === 0) return json({ error: 'No recipients' }, 400, cors);
      const results = [];
      for (const r of recipients) {
        if (!r.phone) { results.push({ name: r.name, success: false, error: 'no phone number' }); continue; }
        const msg = body.message || `Hey ${r.name || 'there'}! You're on ${r.role} this ${r.service}. See you Sunday! 🎵`;
        const result = await twilioSend(env, r.phone, msg);
        results.push({ name: r.name, phone: r.phone, success: !result.error, ...(result.error ? { error: result.error } : { sid: result.sid }) });
      }
      const sent = results.filter(r => r.success).length;
      return json({ sent, total: recipients.length, results }, 200, cors);
    }

    return json({ error: 'Not found' }, 404, cors);
  },
};

function json(obj, status = 200, cors = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
