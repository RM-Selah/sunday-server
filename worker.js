// ─── Sunday API — Cloudflare Worker ───────────────────────────────────────
//
// Proxies the browser app's chat requests to the Anthropic API, holding the
// API key as a Worker secret so users never have to paste their own. Also
// stores church state — roster, team, songs, services, sets — in Cloudflare D1.
//
// Endpoints:
//   GET  /                      → friendly health page
//   GET  /health                → JSON status
//   POST /chat                  → Anthropic /v1/messages proxy
//   POST /church/new            → create church record → { id, adminKey }
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
// Bindings (wrangler.toml):
//   DB                          (D1 database — sunday-db)
//   SUNDAY_STATE                (KV — legacy, kept for backwards compat)

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

function safeJson(val, def) {
  if (val == null) return def;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch(e) { return def; }
}

// Execute D1 statements in chunks (D1 batch limit is ~100 statements)
async function d1Batch(db, stmts) {
  if (!stmts.length) return;
  const CHUNK = 100;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await db.batch(stmts.slice(i, i + CHUNK));
  }
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
        db: !!env.DB,
        kv: !!env.SUNDAY_STATE,
      }, 200, cors);
    }

    // ── Create church ─────────────────────────────────────────────────────────
    // POST /church/new → { id, adminKey }
    if (request.method === 'POST' && url.pathname === '/church/new') {
      if (!env.DB) return json({ error: 'DB not configured' }, 500, cors);
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      const adminKey = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
      await env.DB.batch([
        env.DB.prepare('INSERT INTO churches (id, name) VALUES (?, ?)').bind(id, 'My Church'),
        env.DB.prepare('INSERT INTO church_keys (church_id, admin_key) VALUES (?, ?)').bind(id, adminKey),
      ]);
      return json({ id, adminKey }, 200, cors);
    }

    // ── Load state ────────────────────────────────────────────────────────────
    // GET /state?church=ID → full state blob (public, no auth required)
    if (request.method === 'GET' && url.pathname === '/state') {
      if (!env.DB) return json({ error: 'DB not configured' }, 500, cors);
      const churchId = url.searchParams.get('church');
      if (!churchId) return json({ error: 'church param required' }, 400, cors);

      const church = await env.DB.prepare(
        'SELECT id, name FROM churches WHERE id = ?'
      ).bind(churchId).first();
      if (!church) return json({ error: 'Church not found' }, 404, cors);

      const [rosterRow, people, songs, services, sets] = await Promise.all([
        env.DB.prepare('SELECT * FROM roster_state WHERE church_id = ?').bind(churchId).first(),
        env.DB.prepare('SELECT * FROM people WHERE church_id = ? AND active = 1 ORDER BY tier, name').bind(churchId).all(),
        env.DB.prepare('SELECT * FROM songs WHERE church_id = ? ORDER BY title').bind(churchId).all(),
        env.DB.prepare('SELECT * FROM services WHERE church_id = ? ORDER BY sort_order, name').bind(churchId).all(),
        env.DB.prepare('SELECT * FROM set_lists WHERE church_id = ? ORDER BY created_at DESC LIMIT 100').bind(churchId).all(),
      ]);

      const team = (people.results || []).map(function(p) {
        return {
          id: p.id, name: p.name,
          phone: p.phone || '', email: p.email || '',
          roles: safeJson(p.roles, []),
          tier: p.tier || 2,
          avail: safeJson(p.avail, [1,2,3,4,5]),
          notes: p.notes || '',
          gender: p.gender || '', generation: p.generation || '',
          color: p.color || '', active: p.active === 1,
        };
      });

      const songList = (songs.results || []).map(function(s) {
        return {
          id: s.id, title: s.title, artist: s.artist || '',
          category: s.category || 'current', key: s.key || '',
          bpm: s.bpm || null, tempo: s.tempo || '', mins: s.mins || 4.5,
          notes: s.notes || '',
          lastUsed: s.last_used || null, timesUsed: s.times_used || 0,
        };
      });

      const serviceList = (services.results || []).map(function(s) {
        return {
          id: s.id, slug: s.slug, name: s.name,
          day: s.day || null, time: s.time || null, date: s.date || null,
          recurring: s.recurring === 1, sortOrder: s.sort_order || 0,
        };
      });

      const savedSets = (sets.results || []).map(function(s) {
        const numId = Number(s.id);
        return {
          id: isNaN(numId) ? s.id : numId,
          name: s.name, month: s.month, week: s.week,
          service: s.service_slug,
          savedAt: s.created_at,
          songs: safeJson(s.songs, []),
          ministrySongs: safeJson(s.ministry, []),
        };
      });

      return json({
        churchName: church.name || '',
        roster: safeJson(rosterRow ? rosterRow.roster : null, {}),
        rosterBecause: safeJson(rosterRow ? rosterRow.roster_because : null, {}),
        rosteringRules: rosterRow ? (rosterRow.rostering_rules || '') : '',
        team: team,
        songs: songList,
        services: serviceList,
        savedSets: savedSets,
        updatedAt: rosterRow ? rosterRow.updated_at : new Date().toISOString(),
      }, 200, cors);
    }

    // ── Save state ────────────────────────────────────────────────────────────
    // POST /state?church=ID  body: { adminKey, roster, rosterBecause, team, songs,
    //                                services, savedSets, churchName, rosteringRules }
    if (request.method === 'POST' && url.pathname === '/state') {
      if (!env.DB) return json({ error: 'DB not configured' }, 500, cors);
      const churchId = url.searchParams.get('church');
      if (!churchId) return json({ error: 'church param required' }, 400, cors);

      const keyRow = await env.DB.prepare(
        'SELECT admin_key FROM church_keys WHERE church_id = ?'
      ).bind(churchId).first();
      if (!keyRow) return json({ error: 'Church not found' }, 404, cors);

      let body;
      try { body = await request.json(); } catch(e) { return json({ error: 'Invalid JSON' }, 400, cors); }
      if (body.adminKey !== keyRow.admin_key) return json({ error: 'Unauthorized' }, 403, cors);

      const now = new Date().toISOString();
      const stmts = [];

      // Update church name
      if (body.churchName) {
        stmts.push(
          env.DB.prepare('UPDATE churches SET name = ? WHERE id = ?').bind(body.churchName, churchId)
        );
      }

      // Upsert roster state (roster JSON blob, rosterBecause, rosteringRules)
      stmts.push(env.DB.prepare(`
        INSERT INTO roster_state (church_id, roster, roster_because, rostering_rules, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(church_id) DO UPDATE SET
          roster = excluded.roster,
          roster_because = excluded.roster_because,
          rostering_rules = excluded.rostering_rules,
          updated_at = excluded.updated_at
      `).bind(
        churchId,
        JSON.stringify(body.roster || {}),
        JSON.stringify(body.rosterBecause || {}),
        body.rosteringRules || '',
        now
      ));

      // Upsert team members
      if (Array.isArray(body.team)) {
        for (var i = 0; i < body.team.length; i++) {
          var p = body.team[i];
          if (!p.name) continue;
          stmts.push(env.DB.prepare(`
            INSERT INTO people (id, church_id, name, phone, email, roles, tier, avail,
                                notes, gender, generation, color, active, updated_at)
            VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(church_id, name) DO UPDATE SET
              phone = excluded.phone, email = excluded.email,
              roles = excluded.roles, tier = excluded.tier, avail = excluded.avail,
              notes = excluded.notes, gender = excluded.gender,
              generation = excluded.generation, color = excluded.color,
              active = 1, updated_at = excluded.updated_at
          `).bind(
            churchId, p.name,
            p.phone || null, p.email || null,
            JSON.stringify(Array.isArray(p.roles) ? p.roles : []),
            p.tier || 2,
            JSON.stringify(Array.isArray(p.avail) ? p.avail : [1,2,3,4,5]),
            p.notes || null, p.gender || null, p.generation || null, p.color || null,
            now
          ));
        }
      }

      // Upsert songs
      if (Array.isArray(body.songs)) {
        for (var j = 0; j < body.songs.length; j++) {
          var s = body.songs[j];
          if (!s.title) continue;
          stmts.push(env.DB.prepare(`
            INSERT INTO songs (id, church_id, title, artist, category, key, bpm, tempo,
                               mins, notes, last_used, times_used)
            VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(church_id, title) DO UPDATE SET
              artist = excluded.artist, category = excluded.category,
              key = excluded.key, bpm = excluded.bpm, tempo = excluded.tempo,
              mins = excluded.mins, notes = excluded.notes,
              last_used = excluded.last_used, times_used = excluded.times_used
          `).bind(
            churchId, s.title,
            s.artist || null, s.category || 'current', s.key || null,
            s.bpm || null, s.tempo || null, s.mins || 4.5,
            s.notes || null, s.lastUsed || s.last_used || null,
            s.timesUsed || s.times_used || 0
          ));
        }
      }

      // Upsert services
      if (Array.isArray(body.services)) {
        for (var k = 0; k < body.services.length; k++) {
          var svc = body.services[k];
          if (!svc.name) continue;
          var slug = svc.slug || svc.name.toLowerCase().replace(/\s+/g, '-');
          stmts.push(env.DB.prepare(`
            INSERT INTO services (id, church_id, slug, name, day, time, date, recurring, sort_order)
            VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(church_id, slug) DO UPDATE SET
              name = excluded.name, day = excluded.day, time = excluded.time,
              date = excluded.date, recurring = excluded.recurring,
              sort_order = excluded.sort_order
          `).bind(
            churchId, slug, svc.name,
            svc.day || null, svc.time || null, svc.date || null,
            svc.recurring !== false ? 1 : 0,
            svc.sortOrder || svc.sort_order || 0
          ));
        }
      }

      // Execute main stmts
      await d1Batch(env.DB, stmts);

      // Saved sets: delete all then reinsert (cleanly handles deletions)
      if (Array.isArray(body.savedSets)) {
        const setStmts = [
          env.DB.prepare('DELETE FROM set_lists WHERE church_id = ?').bind(churchId)
        ];
        for (var m = 0; m < body.savedSets.length; m++) {
          var set = body.savedSets[m];
          setStmts.push(env.DB.prepare(`
            INSERT INTO set_lists (id, church_id, name, month, week, service_slug,
                                   songs, ministry, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            String(set.id), churchId,
            set.name || '',
            set.month || null, set.week || null,
            set.service || set.service_slug || null,
            JSON.stringify(set.songs || []),
            JSON.stringify(set.ministrySongs || set.ministry || []),
            set.savedAt || now, now
          ));
        }
        await d1Batch(env.DB, setStmts);
      }

      return json({ ok: true, updatedAt: now }, 200, cors);
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
