// ─── Sunday API — Cloudflare Worker ───────────────────────────────────────
//
// Proxies the browser app's chat requests to the Anthropic API, holding the
// API key as a Worker secret so users never have to paste their own. Stateless
// by design — conversation history lives in the browser (localStorage).
//
// Endpoints:
//   GET  /                   → friendly health page
//   GET  /health             → JSON status
//   POST /chat               → Anthropic /v1/messages proxy (same payload shape)
//   GET  /whatsapp/status    → { enabled: bool } — are Twilio secrets set?
//   POST /whatsapp/send      → send one WhatsApp message via Twilio
//   POST /whatsapp/blast     → send personalised messages to a list of recipients
//
// Secrets (set with `wrangler secret put <NAME>`):
//   ANTHROPIC_API_KEY        (required)
//   TWILIO_ACCOUNT_SID       (required for WhatsApp)
//   TWILIO_AUTH_TOKEN        (required for WhatsApp)
//   TWILIO_FROM              (required for WhatsApp — e.g. whatsapp:+14155238886)
//
// Vars (set in wrangler.toml or dashboard):
//   ANTHROPIC_MODEL          (optional, defaults to claude-sonnet-4-6)

const DEFAULT_MODEL = 'claude-sonnet-4-6';

// CORS allow-list. Anything not on here gets no Allow-Origin header so the
// browser refuses to read the response — protects against rogue sites
// piggybacking on the worker to burn through the API key.
//
// Add more as the product grows (e.g. app.runworship.com, sunday subdomain).
const ALLOWED_ORIGINS = new Set([
  'https://runworship.com',
  'https://www.runworship.com',
  'http://runworship.com',          // until GH Pages cert lands — drop later
  'http://www.runworship.com',      // ditto
  'https://runchurch.com',
  'https://www.runchurch.com',
  'http://runchurch.com',
  'http://www.runchurch.com',
  'https://rm-selah.github.io',     // legacy GitHub Pages URL
  'http://localhost:8080',          // local dev (python -m http.server)
  'http://localhost:5173',          // vite default
  'http://localhost:3000',          // anything else common
  'http://127.0.0.1:8080',
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

// Call the Twilio Messages API to send one WhatsApp message.
// `to` can be a bare E.164 number or already prefixed with "whatsapp:".
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
  if (!res.ok) {
    return { error: data.message || 'Twilio error', code: data.code };
  }
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

    // Root — friendly landing
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      return new Response(
        '<h2>☀ Sunday API</h2><p>Up and running. POST /chat to use.</p>',
        { headers: { ...cors, 'Content-Type': 'text/html' } }
      );
    }

    // Health
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        status: 'ok',
        model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        has_key: !!env.ANTHROPIC_API_KEY,
        whatsapp: hasWhatsApp(env),
      }, 200, cors);
    }

    // Chat — proxies to Anthropic /v1/messages with same payload shape
    if (request.method === 'POST' && url.pathname === '/chat') {
      const origin = request.headers.get('Origin');
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return json({ error: 'Origin not allowed' }, 403, cors);
      }

      if (!env.ANTHROPIC_API_KEY) {
        return json({ error: 'ANTHROPIC_API_KEY not set on the Worker' }, 500, cors);
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: 'Invalid JSON' }, 400, cors);
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = body.system || '';
      const model = body.model || env.ANTHROPIC_MODEL || DEFAULT_MODEL;
      const maxTokens = body.max_tokens || 4096;

      if (messages.length === 0) {
        return json({ error: 'messages array is required' }, 400, cors);
      }

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
        headers: {
          ...cors,
          'Content-Type': upstream.headers.get('content-type') || 'application/json',
        },
      });
    }

    // WhatsApp — status check
    if (request.method === 'GET' && url.pathname === '/whatsapp/status') {
      return json({ enabled: hasWhatsApp(env) }, 200, cors);
    }

    // WhatsApp — send one message
    if (request.method === 'POST' && url.pathname === '/whatsapp/send') {
      const origin = request.headers.get('Origin');
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return json({ error: 'Origin not allowed' }, 403, cors);
      }
      if (!hasWhatsApp(env)) {
        return json({ error: 'WhatsApp not configured on Worker — run: wrangler secret put TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM' }, 503, cors);
      }

      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400, cors); }

      const { to, body: msgBody } = body;
      if (!to || !msgBody) {
        return json({ error: '"to" and "body" are required' }, 400, cors);
      }

      const result = await twilioSend(env, to, msgBody);
      return json(result, result.error ? 502 : 200, cors);
    }

    // WhatsApp — blast a list of recipients
    // Expects: { recipients: [{ phone, name, role, service }], message?: string }
    // The browser builds the recipient list from roster state so the Worker stays stateless.
    if (request.method === 'POST' && url.pathname === '/whatsapp/blast') {
      const origin = request.headers.get('Origin');
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return json({ error: 'Origin not allowed' }, 403, cors);
      }
      if (!hasWhatsApp(env)) {
        return json({ error: 'WhatsApp not configured on Worker — run: wrangler secret put TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM' }, 503, cors);
      }

      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400, cors); }

      const recipients = Array.isArray(body.recipients) ? body.recipients : [];
      if (recipients.length === 0) {
        return json({ error: 'No recipients' }, 400, cors);
      }

      const results = [];
      for (const r of recipients) {
        if (!r.phone) {
          results.push({ name: r.name, success: false, error: 'no phone number' });
          continue;
        }
        // Use a custom message if provided, otherwise a friendly default.
        const msg = body.message ||
          `Hey ${r.name || 'there'}! You're on ${r.role} this ${r.service}. See you Sunday! 🎵`;
        const result = await twilioSend(env, r.phone, msg);
        results.push({
          name: r.name,
          phone: r.phone,
          success: !result.error,
          ...(result.error ? { error: result.error } : { sid: result.sid }),
        });
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
