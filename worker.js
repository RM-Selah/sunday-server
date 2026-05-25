// ─── Sunday API — Cloudflare Worker ───────────────────────────────────────
//
// Proxies the browser app's chat requests to the Anthropic API, holding the
// API key as a Worker secret so users never have to paste their own. Stateless
// by design — conversation history lives in the browser (localStorage).
//
// Endpoints:
//   GET  /            → friendly health page
//   GET  /health      → JSON status
//   POST /chat        → Anthropic /v1/messages proxy (same payload shape)
//
// Secrets (set with `wrangler secret put <NAME>`):
//   ANTHROPIC_API_KEY  (required)
//
// Vars (set in wrangler.toml or dashboard):
//   ANTHROPIC_MODEL    (optional, defaults to claude-sonnet-4-6)

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
      }, 200, cors);
    }

    // Chat — proxies to Anthropic /v1/messages with same payload shape
    if (request.method === 'POST' && url.pathname === '/chat') {
      // Block calls from origins not on the allow-list (defense against
      // browser-based abuse). Direct curl / server-side calls still work
      // because they don't carry an Origin header.
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

    return json({ error: 'Not found' }, 404, cors);
  },
};

function json(obj, status = 200, cors = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
