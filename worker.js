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

// Allow the GitHub Pages front-end and any future runworship.com pages to call us.
// '*' is fine for now since the only sensitive thing (the API key) lives on the
// Worker, not in headers the browser sends.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Root — friendly landing
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      return new Response(
        '<h2>☀ Sunday API</h2><p>Up and running. POST /chat to use.</p>',
        { headers: { ...CORS_HEADERS, 'Content-Type': 'text/html' } }
      );
    }

    // Health
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        status: 'ok',
        model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        has_key: !!env.ANTHROPIC_API_KEY,
      });
    }

    // Chat — proxies to Anthropic /v1/messages with same payload shape
    if (request.method === 'POST' && url.pathname === '/chat') {
      if (!env.ANTHROPIC_API_KEY) {
        return json({ error: 'ANTHROPIC_API_KEY not set on the Worker' }, 500);
      }

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = body.system || '';
      const model = body.model || env.ANTHROPIC_MODEL || DEFAULT_MODEL;
      const maxTokens = body.max_tokens || 4096;

      if (messages.length === 0) {
        return json({ error: 'messages array is required' }, 400);
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
          ...CORS_HEADERS,
          'Content-Type': upstream.headers.get('content-type') || 'application/json',
        },
      });
    }

    return json({ error: 'Not found' }, 404);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
