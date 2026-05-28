// ─── Sunday API — Cloudflare Worker ───────────────────────────────────────
//
// Proxies the browser app's chat requests to the Anthropic API, holding the
// API key as a Worker secret so users never have to paste their own. Also
// stores church state — roster, team, songs, services, sets — in Cloudflare D1.
//
// Endpoints:
//   GET  /                      → friendly health page
//   GET  /health                → JSON status
//   POST /auth/magic            → request magic link email
//   POST /auth/verify           → verify magic link token → session
//   GET  /members?session=TOKEN → list church members (requires session)
//   POST /members/add           → add a member (requires admin session)
//   POST /chat                  → Anthropic /v1/messages proxy
//   POST /church/new            → create church record → { id, adminKey }
//   GET  /state?church=ID       → load church state (public, or filtered by session)
//   POST /state?church=ID       → save church state (requires adminKey or sessionToken)
//   GET  /whatsapp/status       → { enabled: bool }
//   POST /whatsapp/send         → send one WhatsApp message via Twilio
//   POST /whatsapp/blast        → send personalised messages to a list
//
// Secrets (set with `wrangler secret put <NAME>`):
//   ANTHROPIC_API_KEY           (required)
//   TWILIO_ACCOUNT_SID          (required for WhatsApp)
//   TWILIO_AUTH_TOKEN           (required for WhatsApp)
//   TWILIO_FROM                 (required for WhatsApp — e.g. whatsapp:+14155238886)
//   RESEND_API_KEY              (optional — email magic links; logs URL to console if missing)
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

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function validateSession(env, token) {
  if (!token || !env.DB) return null;
  return await env.DB.prepare(
    'SELECT * FROM sessions WHERE token = ? AND expires_at > ?'
  ).bind(token, new Date().toISOString()).first();
}

async function sendMagicLinkEmail(env, to, magicUrl, churchName) {
  if (!env.RESEND_API_KEY) {
    console.log('[dev] Magic link for', to, '→', magicUrl);
    return { ok: true, dev: true };
  }
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#050507;font-family:-apple-system,sans-serif;">
  <div style="max-width:480px;margin:40px auto;padding:32px 24px;background:#0a0a10;border-radius:12px;border:1px solid rgba(255,255,255,0.08);">
    <div style="font-family:Georgia,serif;font-size:36px;font-weight:300;color:#e8e8f2;margin-bottom:4px;">The Local</div>
    <div style="font-size:10px;font-weight:500;letter-spacing:3px;text-transform:uppercase;color:#38385a;margin-bottom:32px;">Worship Team</div>
    <p style="font-size:15px;color:rgba(232,232,242,0.7);line-height:1.6;margin:0 0 28px;">
      Here's your sign-in link for ${churchName || 'The Local'}. It expires in 30 minutes.
    </p>
    <a href="${magicUrl}" style="display:inline-block;background:#e09a2d;color:#050507;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600;font-family:-apple-system,sans-serif;">Sign in to The Local →</a>
    <p style="font-size:12px;color:#38385a;margin-top:28px;line-height:1.5;">
      If you didn't request this, you can safely ignore it.<br>
      This link only works once.
    </p>
  </div>
</body>
</html>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'The Local <noreply@runworship.com>',
      to: [to],
      subject: 'Sign in to The Local',
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('[resend] Error sending to', to, ':', err);
    return { ok: false, error: err };
  }
  return { ok: true };
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

    // ── Magic link request ────────────────────────────────────────────────────
    // POST /auth/magic  body: { email, churchId? }
    if (request.method === 'POST' && url.pathname === '/auth/magic') {
      if (!env.DB) return json({ error: 'DB not configured' }, 500, cors);
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: 'Invalid JSON' }, 400, cors); }
      const email = (body.email || '').trim().toLowerCase();
      if (!email || email.indexOf('@') < 0) return json({ error: 'Valid email required' }, 400, cors);

      // Find or create user
      let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      if (!user) {
        const newId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        await env.DB.prepare(
          'INSERT INTO users (id, email) VALUES (?, ?)'
        ).bind(newId, email).run();
        user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(newId).first();
      }

      // Delete any old magic links for this user
      await env.DB.prepare('DELETE FROM magic_links WHERE user_id = ?').bind(user.id).run();

      // Generate new magic token
      const magicToken = crypto.randomUUID().replace(/-/g, '');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const churchId = body.churchId || null;
      await env.DB.prepare(
        'INSERT INTO magic_links (token, user_id, church_id, expires_at) VALUES (?, ?, ?, ?)'
      ).bind(magicToken, user.id, churchId, expiresAt).run();

      // Determine magic URL
      const origin = request.headers.get('Origin') || 'https://runworship.com';
      const appOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://runworship.com';
      const magicUrl = appOrigin + '/?magicToken=' + magicToken;

      // Fetch church name for email
      let churchName = 'The Local';
      if (churchId) {
        const ch = await env.DB.prepare('SELECT name FROM churches WHERE id = ?').bind(churchId).first();
        if (ch) churchName = ch.name || churchName;
      }

      // Send email (or dev mode)
      const emailResult = await sendMagicLinkEmail(env, email, magicUrl, churchName);
      if (emailResult.dev) {
        return json({ ok: true, dev: true, magicUrl }, 200, cors);
      }
      if (!emailResult.ok) {
        return json({ ok: false, error: 'Failed to send email' }, 500, cors);
      }
      return json({ ok: true }, 200, cors);
    }

    // ── Magic link verify ─────────────────────────────────────────────────────
    // POST /auth/verify  body: { token, inviteKey? }
    if (request.method === 'POST' && url.pathname === '/auth/verify') {
      if (!env.DB) return json({ error: 'DB not configured' }, 500, cors);
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: 'Invalid JSON' }, 400, cors); }
      const { token, inviteKey } = body;
      if (!token) return json({ error: 'Token required' }, 400, cors);

      const now = new Date().toISOString();
      const link = await env.DB.prepare(
        'SELECT * FROM magic_links WHERE token = ?'
      ).bind(token).first();
      if (!link) return json({ error: 'Link not found or already used' }, 404, cors);
      if (link.expires_at < now) return json({ error: 'Link expired — request a new one' }, 410, cors);

      // Delete the link (one-time use)
      await env.DB.prepare('DELETE FROM magic_links WHERE token = ?').bind(token).run();

      // Update last_sign_in
      await env.DB.prepare(
        'UPDATE users SET last_sign_in = ? WHERE id = ?'
      ).bind(now, link.user_id).run();

      // Determine church + role
      let churchId = link.church_id;
      let role = 'viewer';
      let churchName = 'The Local';

      if (churchId) {
        // Check church_members
        const membership = await env.DB.prepare(
          'SELECT role FROM church_members WHERE user_id = ? AND church_id = ?'
        ).bind(link.user_id, churchId).first();

        if (membership) {
          role = membership.role;
        } else {
          // Check invite key
          const keyRow = await env.DB.prepare(
            'SELECT admin_key FROM church_keys WHERE church_id = ?'
          ).bind(churchId).first();

          let joined = false;
          if (inviteKey && keyRow && inviteKey === keyRow.admin_key) {
            role = 'admin';
            joined = true;
          } else {
            // First user ever for this church?
            const memberCount = await env.DB.prepare(
              'SELECT COUNT(*) as cnt FROM church_members WHERE church_id = ?'
            ).bind(churchId).first();
            if (memberCount && memberCount.cnt === 0) {
              role = 'admin';
              joined = true;
            }
          }

          if (joined) {
            await env.DB.prepare(
              'INSERT OR REPLACE INTO church_members (user_id, church_id, role) VALUES (?, ?, ?)'
            ).bind(link.user_id, churchId, role).run();
          } else {
            return json({ error: 'Not a member — ask your pastor to add you' }, 403, cors);
          }
        }

        const ch = await env.DB.prepare('SELECT name FROM churches WHERE id = ?').bind(churchId).first();
        if (ch) churchName = ch.name || churchName;
      } else {
        // No church on link — look up all memberships
        const memberships = await env.DB.prepare(
          'SELECT cm.church_id, cm.role, c.name FROM church_members cm LEFT JOIN churches c ON c.id = cm.church_id WHERE cm.user_id = ?'
        ).bind(link.user_id).all();
        const rows = memberships.results || [];
        if (rows.length === 0) return json({ error: 'No church linked to this account — ask your pastor to add you' }, 403, cors);
        if (rows.length === 1) {
          churchId = rows[0].church_id;
          role = rows[0].role;
          churchName = rows[0].name || churchName;
        } else {
          // Multiple churches — return list for client to pick (future feature)
          return json({ error: 'Multiple churches found — use a direct invite link' }, 409, cors);
        }
      }

      // Create session (90-day)
      const sessionToken = crypto.randomUUID().replace(/-/g, '');
      const sessionExpires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
      await env.DB.prepare(
        'INSERT INTO sessions (token, user_id, church_id, role, expires_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(sessionToken, link.user_id, churchId, role, sessionExpires).run();

      return json({
        ok: true,
        sessionToken,
        userId: link.user_id,
        churchId,
        role,
        churchName,
        sessionExpires,
      }, 200, cors);
    }

    // ── List members ──────────────────────────────────────────────────────────
    // GET /members?session=TOKEN
    if (request.method === 'GET' && url.pathname === '/members') {
      if (!env.DB) return json({ error: 'DB not configured' }, 500, cors);
      const sessionToken = url.searchParams.get('session');
      const session = await validateSession(env, sessionToken);
      if (!session) return json({ error: 'Unauthorized' }, 401, cors);

      const rows = await env.DB.prepare(`
        SELECT u.id, u.email, u.name, cm.role, u.last_sign_in, cm.joined_at
        FROM church_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.church_id = ?
        ORDER BY cm.joined_at
      `).bind(session.church_id).all();

      return json({ members: rows.results || [] }, 200, cors);
    }

    // ── Add member ────────────────────────────────────────────────────────────
    // POST /members/add  body: { sessionToken, email, name?, role }
    if (request.method === 'POST' && url.pathname === '/members/add') {
      if (!env.DB) return json({ error: 'DB not configured' }, 500, cors);
      let body;
      try { body = await request.json(); } catch(e) { return json({ error: 'Invalid JSON' }, 400, cors); }
      const session = await validateSession(env, body.sessionToken);
      if (!session) return json({ error: 'Unauthorized' }, 401, cors);
      if (session.role === 'viewer') return json({ error: 'Admin access required' }, 403, cors);

      const email = (body.email || '').trim().toLowerCase();
      if (!email || email.indexOf('@') < 0) return json({ error: 'Valid email required' }, 400, cors);
      const role = body.role || 'viewer';

      // Find or create user
      let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      if (!user) {
        const newId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        await env.DB.prepare(
          'INSERT INTO users (id, email, name) VALUES (?, ?, ?)'
        ).bind(newId, email, body.name || null).run();
        user = { id: newId };
      } else if (body.name) {
        await env.DB.prepare('UPDATE users SET name = ? WHERE id = ? AND name IS NULL').bind(body.name, user.id).run();
      }

      // Upsert membership
      await env.DB.prepare(
        'INSERT OR REPLACE INTO church_members (user_id, church_id, role) VALUES (?, ?, ?)'
      ).bind(user.id, session.church_id, role).run();

      return json({ ok: true, userId: user.id }, 200, cors);
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
    // GET /state?church=ID  (optional: &session=TOKEN for set-list filtering)
    if (request.method === 'GET' && url.pathname === '/state') {
      if (!env.DB) return json({ error: 'DB not configured' }, 500, cors);
      const churchId = url.searchParams.get('church');
      if (!churchId) return json({ error: 'church param required' }, 400, cors);

      const church = await env.DB.prepare(
        'SELECT id, name FROM churches WHERE id = ?'
      ).bind(churchId).first();
      if (!church) return json({ error: 'Church not found' }, 404, cors);

      // Optional session-based filtering for set_lists
      const sessionToken = url.searchParams.get('session');
      const session = sessionToken ? await validateSession(env, sessionToken) : null;

      let setsQuery;
      if (session && session.church_id === churchId) {
        // Show sets saved by this user, or sets with no saved_by
        setsQuery = env.DB.prepare(
          'SELECT * FROM set_lists WHERE church_id = ? AND (saved_by = ? OR saved_by IS NULL) ORDER BY created_at DESC LIMIT 100'
        ).bind(churchId, session.user_id).all();
      } else {
        setsQuery = env.DB.prepare(
          'SELECT * FROM set_lists WHERE church_id = ? ORDER BY created_at DESC LIMIT 100'
        ).bind(churchId).all();
      }

      const [rosterRow, people, songs, services, sets] = await Promise.all([
        env.DB.prepare('SELECT * FROM roster_state WHERE church_id = ?').bind(churchId).first(),
        env.DB.prepare('SELECT * FROM people WHERE church_id = ? AND active = 1 ORDER BY tier, name').bind(churchId).all(),
        env.DB.prepare('SELECT * FROM songs WHERE church_id = ? ORDER BY title').bind(churchId).all(),
        env.DB.prepare('SELECT * FROM services WHERE church_id = ? ORDER BY sort_order, name').bind(churchId).all(),
        setsQuery,
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
    // POST /state?church=ID  body: { sessionToken | adminKey, roster, rosterBecause,
    //                                team, songs, services, savedSets, churchName, rosteringRules }
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

      // Auth: try sessionToken first, fall back to adminKey
      let authedUserId = null;
      if (body.sessionToken) {
        const session = await validateSession(env, body.sessionToken);
        if (!session || session.church_id !== churchId) return json({ error: 'Unauthorized' }, 403, cors);
        if (session.role === 'viewer') return json({ error: 'Unauthorized' }, 403, cors);
        authedUserId = session.user_id;
      } else if (body.adminKey) {
        if (body.adminKey !== keyRow.admin_key) return json({ error: 'Unauthorized' }, 403, cors);
      } else {
        return json({ error: 'Unauthorized' }, 403, cors);
      }

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

      // Saved sets: delete only this user's sets (or all if using adminKey), then reinsert
      if (Array.isArray(body.savedSets)) {
        let deleteStmt;
        if (authedUserId) {
          // Session auth: only delete sets belonging to this user
          deleteStmt = env.DB.prepare(
            'DELETE FROM set_lists WHERE church_id = ? AND saved_by = ?'
          ).bind(churchId, authedUserId);
        } else {
          // Legacy adminKey: delete all sets for the church (old behaviour)
          deleteStmt = env.DB.prepare('DELETE FROM set_lists WHERE church_id = ?').bind(churchId);
        }
        const setStmts = [deleteStmt];
        for (var m = 0; m < body.savedSets.length; m++) {
          var set = body.savedSets[m];
          setStmts.push(env.DB.prepare(`
            INSERT INTO set_lists (id, church_id, name, month, week, service_slug,
                                   songs, ministry, saved_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            String(set.id), churchId,
            set.name || '',
            set.month || null, set.week || null,
            set.service || set.service_slug || null,
            JSON.stringify(set.songs || []),
            JSON.stringify(set.ministrySongs || set.ministry || []),
            authedUserId || null,
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
