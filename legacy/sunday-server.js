/**
 * Sunday Server v2.0
 * API proxy + WhatsApp conversation engine + Supabase sync
 *
 * Usage:
 *   1. Set your API key:         export ANTHROPIC_API_KEY=sk-ant-...
 *   2. (Optional) WhatsApp:      export TWILIO_ACCOUNT_SID=AC...
 *                                export TWILIO_AUTH_TOKEN=...
 *                                export TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
 *   3. (Optional) Supabase:      export SUPABASE_URL=https://xxx.supabase.co
 *                                export SUPABASE_KEY=eyJ...
 *   4. Run:                      node sunday-server.js
 *   5. Open worship-practice.html in your browser
 *
 * Endpoints:
 *   GET  /health            — Server status
 *   POST /chat              — Sunday AI (browser → Claude)
 *   POST /clear             — Clear conversation memory
 *   POST /whatsapp/webhook  — Twilio inbound (WhatsApp → Sunday)
 *   POST /whatsapp/send     — Send outbound WhatsApp message
 *   POST /whatsapp/blast    — Send roster to entire team via WhatsApp
 *   GET  /whatsapp/status   — WhatsApp connection status
 */

const http = require('http');
const https = require('https');
const querystring = require('querystring');

// ─── Config ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3456;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// Twilio WhatsApp config
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM || ''; // whatsapp:+14155238886
const WHATSAPP_ENABLED = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);

// Supabase config
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

if (!API_KEY) {
  console.log('\n  ⚠  No API key found.\n');
  console.log('  Set it with:  export ANTHROPIC_API_KEY=sk-ant-...');
  console.log('  Then run:     node sunday-server.js\n');
  process.exit(1);
}

// ─── Conversation Memory ───────────────────────────────────────
const conversationHistory = {
  set: [],
  roster: [],
  agent: []
};

// WhatsApp conversation memory per phone number
const whatsappConversations = {};
const MAX_HISTORY = 20;
const MAX_WA_HISTORY = 10;
const MAX_BODY = 20 * 1024 * 1024;

function addToHistory(screen, role, content) {
  if (!conversationHistory[screen]) conversationHistory[screen] = [];
  conversationHistory[screen].push({ role, content });
  if (conversationHistory[screen].length > MAX_HISTORY) {
    conversationHistory[screen] = conversationHistory[screen].slice(-MAX_HISTORY);
  }
}

function addToWAHistory(phone, role, content) {
  if (!whatsappConversations[phone]) whatsappConversations[phone] = [];
  whatsappConversations[phone].push({ role, content, ts: Date.now() });
  if (whatsappConversations[phone].length > MAX_WA_HISTORY) {
    whatsappConversations[phone] = whatsappConversations[phone].slice(-MAX_WA_HISTORY);
  }
}

// ─── Shared roster/team state (synced from browser) ────────────
let sharedState = {
  churchName: '',
  team: [],
  services: [],
  roster: {},
  songs: []
};

// ─── Claude API call helper ────────────────────────────────────
function callClaude(system, messages, callback) {
  const payload = JSON.stringify({
    model: MODEL,
    max_tokens: 4096,
    system: system,
    messages: messages
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => { data += chunk; });
    apiRes.on('end', () => {
      try {
        const response = JSON.parse(data);
        const text = response.content && response.content[0] ? response.content[0].text : '';
        callback(null, text, apiRes.statusCode);
      } catch(e) {
        callback(e, data, apiRes.statusCode);
      }
    });
  });

  apiReq.on('error', (e) => callback(e, null, 500));
  apiReq.write(payload);
  apiReq.end();
}

// ─── Twilio WhatsApp sender ────────────────────────────────────
function sendWhatsApp(to, body, callback) {
  if (!WHATSAPP_ENABLED) {
    if (callback) callback(new Error('WhatsApp not configured'));
    return;
  }

  // Ensure whatsapp: prefix
  const toNum = to.startsWith('whatsapp:') ? to : 'whatsapp:' + to;

  const postData = querystring.stringify({
    From: TWILIO_FROM,
    To: toNum,
    Body: body
  });

  const auth = Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');

  const options = {
    hostname: 'api.twilio.com',
    path: `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + auth,
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        console.log(`  📤 WhatsApp → ${toNum}: "${body.substring(0, 60)}..."`);
        if (callback) callback(null, result);
      } catch(e) {
        if (callback) callback(e, data);
      }
    });
  });

  req.on('error', (e) => { if (callback) callback(e); });
  req.write(postData);
  req.end();
}

// ─── WhatsApp AI — Sunday processes inbound messages ───────────
function processWhatsAppMessage(phone, incomingBody, personName, callback) {
  addToWAHistory(phone, 'user', incomingBody);

  // Build context about the team member
  const person = sharedState.team.find(t => t.phone === phone || t.name === personName);
  const rosterInfo = person ? getRosterInfoForPerson(person.name) : '';

  const system = `You are Sunday, a warm worship team assistant for ${sharedState.churchName || 'a local church'}.
You are having a WhatsApp conversation with ${personName || 'a team member'}.
${person ? `They play: ${(person.roles || []).join(', ')}` : ''}
${rosterInfo ? `Their upcoming roster:\n${rosterInfo}` : ''}

CONVERSATION STYLE:
- Keep messages SHORT (1-3 sentences max). This is WhatsApp, not email.
- Be warm, personal, and natural. Use their first name.
- If they confirm availability, say great and note it.
- If they decline or say they're away, be gracious and understanding.
- If they ask about the roster, tell them their upcoming slots.
- If they share song suggestions, acknowledge warmly.
- Don't use emojis excessively. One max per message.

RESPOND WITH ONLY the message text. No JSON, no formatting. Just the WhatsApp reply.`;

  const messages = (whatsappConversations[phone] || []).map(m => ({
    role: m.role,
    content: m.content
  }));

  callClaude(system, messages, (err, reply) => {
    if (err || !reply) {
      if (callback) callback(err, null);
      return;
    }

    // Clean up — remove any JSON or markdown
    const cleanReply = reply.replace(/```[\s\S]*?```/g, '').replace(/\{[\s\S]*\}/g, '').trim();
    addToWAHistory(phone, 'assistant', cleanReply);

    // Send via Twilio
    sendWhatsApp(phone, cleanReply, (sendErr, result) => {
      if (callback) callback(sendErr, { reply: cleanReply, sid: result ? result.sid : null });
    });
  });
}

function getRosterInfoForPerson(name) {
  const roster = sharedState.roster || {};
  const matches = [];
  Object.keys(roster).forEach(key => {
    const slots = roster[key];
    Object.keys(slots).forEach(role => {
      if (slots[role] === name) {
        matches.push(`${key}: ${role}`);
      }
    });
  });
  return matches.join('\n');
}

// ─── HTTP Server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Root — Render health check + browser confirmation
  if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>☀ Sunny is running</h2><p>WhatsApp: ' + (WHATSAPP_ENABLED ? '✓ connected' : 'not configured') + '</p>');
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      model: MODEL,
      whatsapp: WHATSAPP_ENABLED,
      supabase: !!(SUPABASE_URL && SUPABASE_KEY)
    }));
    return;
  }

  // Clear memory
  if (req.method === 'POST' && req.url === '/clear') {
    conversationHistory.set = [];
    conversationHistory.roster = [];
    conversationHistory.agent = [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'cleared' }));
    return;
  }

  // WhatsApp status
  if (req.method === 'GET' && req.url === '/whatsapp/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      enabled: WHATSAPP_ENABLED,
      from: WHATSAPP_ENABLED ? TWILIO_FROM : null,
      activeConversations: Object.keys(whatsappConversations).length
    }));
    return;
  }

  // Sync state from browser (keeps server aware of team/roster)
  if (req.method === 'POST' && req.url === '/sync-state') {
    readBody(req, res, (parsed) => {
      if (parsed.team) sharedState.team = parsed.team;
      if (parsed.services) sharedState.services = parsed.services;
      if (parsed.roster) sharedState.roster = parsed.roster;
      if (parsed.songs) sharedState.songs = parsed.songs;
      if (parsed.churchName) sharedState.churchName = parsed.churchName;
      console.log(`  🔄 State synced: ${sharedState.team.length} people, ${sharedState.services.length} services`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'synced' }));
    });
    return;
  }

  // ─── WhatsApp inbound webhook (Twilio POST) ─────────────────
  if (req.method === 'POST' && req.url === '/whatsapp/webhook') {
    readBody(req, res, (parsed) => {
      // Twilio sends form-encoded data
      let data = parsed;
      if (typeof parsed === 'string') {
        try { data = querystring.parse(parsed); } catch(e) { data = parsed; }
      }

      const from = data.From || data.from || '';  // whatsapp:+64211234567
      const body = data.Body || data.body || '';
      const phone = from.replace('whatsapp:', '');

      console.log(`  📥 WhatsApp ← ${phone}: "${body}"`);

      // Match phone to team member
      const person = sharedState.team.find(t => t.phone === phone);
      const personName = person ? person.name : phone;

      // Process with Sunday AI
      processWhatsAppMessage(phone, body, personName, (err, result) => {
        // Twilio expects TwiML response
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end('<Response></Response>'); // We send reply via API, not TwiML
      });
    }, true); // raw body for form-encoded
    return;
  }

  // ─── Send WhatsApp message (from browser) ───────────────────
  if (req.method === 'POST' && req.url === '/whatsapp/send') {
    readBody(req, res, (parsed) => {
      if (!WHATSAPP_ENABLED) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'WhatsApp not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_WHATSAPP_FROM environment variables.' }));
        return;
      }

      const to = parsed.to;
      const body = parsed.body;

      if (!to || !body) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing "to" and "body"' }));
        return;
      }

      sendWhatsApp(to, body, (err, result) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'sent', sid: result.sid }));
        }
      });
    });
    return;
  }

  // ─── Blast roster to team via WhatsApp ──────────────────────
  if (req.method === 'POST' && req.url === '/whatsapp/blast') {
    readBody(req, res, (parsed) => {
      if (!WHATSAPP_ENABLED) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'WhatsApp not configured' }));
        return;
      }

      const month = parsed.month || '';
      const week = parsed.week || '';
      const service = parsed.service || '';
      const message = parsed.message || '';

      // Find people rostered this week and message each
      const key = `${month}-${week}-${service}`;
      const roster = sharedState.roster[key] || {};
      const sent = [];
      const failed = [];

      const people = [...new Set(Object.values(roster))]; // unique names
      let pending = people.length;

      if (pending === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'no_people', sent: [], failed: [] }));
        return;
      }

      people.forEach(name => {
        const person = sharedState.team.find(t => t.name === name);
        if (!person || !person.phone) {
          failed.push({ name, reason: 'no phone number' });
          pending--;
          if (pending === 0) finish();
          return;
        }

        // Find their role(s) this week
        const roles = Object.keys(roster).filter(r => roster[r] === name);
        const personalMsg = message || `Hey ${name.split(' ')[0]}! You're on ${roles.join(' & ')} this ${service} (${week}). Let me know if that works for you 🙏`;

        sendWhatsApp(person.phone, personalMsg, (err) => {
          if (err) {
            failed.push({ name, reason: err.message });
          } else {
            sent.push({ name, phone: person.phone });
          }
          pending--;
          if (pending === 0) finish();
        });
      });

      function finish() {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'done', sent, failed }));
      }
    });
    return;
  }

  // ─── Main chat endpoint (browser → Claude) ──────────────────
  if (req.method === 'POST' && req.url === '/chat') {
    readBody(req, res, (parsed) => {
      const screen = parsed.screen || 'set';
      const userContent = parsed.messages && parsed.messages[0] ? parsed.messages[0].content : '';

      let historyText = userContent;
      if (Array.isArray(userContent)) {
        historyText = userContent
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join(' ') || '[file attached]';
      }
      addToHistory(screen, 'user', historyText);

      const history = conversationHistory[screen].slice(0, -1);
      const messages = history.map(m => ({ role: m.role, content: m.content }));
      messages.push({ role: 'user', content: userContent });

      const payload = JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: parsed.system || '',
        messages: messages
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => { data += chunk; });
        apiRes.on('end', () => {
          try {
            const apiResponse = JSON.parse(data);
            if (apiResponse.content && apiResponse.content[0]) {
              addToHistory(screen, 'assistant', apiResponse.content[0].text);
            }
          } catch(e) {}

          res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });

      apiReq.on('error', (e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });

      apiReq.write(payload);
      apiReq.end();
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── Body reader helper ────────────────────────────────────────
function readBody(req, res, callback, raw) {
  let body = '';
  let bodySize = 0;
  req.on('data', chunk => {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      req.destroy();
      return;
    }
    body += chunk;
  });
  req.on('end', () => {
    if (raw) {
      // Try JSON first, fall back to form-encoded, then raw
      try {
        callback(JSON.parse(body));
      } catch(e) {
        callback(querystring.parse(body));
      }
      return;
    }
    try {
      callback(JSON.parse(body));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  });
}

// ─── Start ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('  ┌───────────────────────────────────────────┐');
  console.log('  │            ☀  Sunday Server v2  ☀           │');
  console.log('  │                                             │');
  console.log('  │  Running on http://localhost:' + PORT + '        │');
  console.log('  │  Model: ' + MODEL.padEnd(32) + '│');
  console.log('  │  API key: ****' + API_KEY.slice(-6).padEnd(27) + '│');
  console.log('  │  Memory: ON (20 msgs/screen)               │');
  console.log('  │  Vision: ON (image drops supported)         │');
  console.log('  │  WhatsApp: ' + (WHATSAPP_ENABLED ? 'ON ✓' : 'OFF (set Twilio env vars)').padEnd(31) + '│');
  console.log('  │  Supabase: ' + (SUPABASE_URL ? 'ON ✓' : 'OFF (set SUPABASE_URL)').padEnd(31) + '│');
  console.log('  │                                             │');
  console.log('  │  Open worship-practice.html                 │');
  console.log('  │  Sunday will connect automatically.         │');
  console.log('  └───────────────────────────────────────────┘');
  console.log('');

  if (WHATSAPP_ENABLED) {
    console.log('  WhatsApp webhook URL (set in Twilio console):');
    console.log('  https://YOUR_DOMAIN/whatsapp/webhook');
    console.log('');
    console.log('  For local dev, use ngrok:');
    console.log('  ngrok http ' + PORT);
    console.log('');
  }
});
