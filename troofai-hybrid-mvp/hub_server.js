// hub_server.js
// Run: node hub_server.js
// package.json: { "type": "module" }

import { WebSocketServer } from 'ws';
import fs from 'fs';
import crypto from 'crypto';

const PORT = process.env.PORT || 8080;
const HUB_TOKEN = process.env.HUB_TOKEN || null;

const wss = new WebSocketServer({ port: PORT });
console.log(`[TroofAI Hub] ws://127.0.0.1:${PORT}`);

// ------------------------ persisted key directory ------------------------
const KEYS_PATH = './keys.json';
function loadKeys() {
  try {
    const raw = fs.readFileSync(KEYS_PATH, 'utf8');
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}
function saveKeys(map) {
  fs.writeFileSync(KEYS_PATH, JSON.stringify(Object.fromEntries(map), null, 2));
}

// ------------------------ persisted meetings/roster ----------------------
const STATE_PATH = './hub_state.json';
function loadState(){
  try { return JSON.parse(fs.readFileSync(STATE_PATH,'utf8')); } catch { return { meetings: {} }; }
}
function saveState(){
  const obj = { meetings: {} };
  for (const [mid, data] of meetings) obj.meetings[mid] = { roster: [...data.roster.values()] };
  fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2));
}

// ------------------------ enrollment codes -------------------------------
const enrollCodes = new Map([
  ['CISO-2025', { id: 'ciso', displayName: 'CISO (Maya)' }],
  // ['CFO-2025',  { id: 'cfo',  displayName: 'CFO (Alice)' }],
]);

// ------------------------ hub state --------------------------------------
const senders   = new Map(); // participantId -> ws
const verifiers = new Set(); // set<ws>
const roster    = new Map(); // participantId -> { id, displayName, enrolled, hasKey }
const keys      = loadKeys(); // participantId -> publicPem (PEM SPKI)
const meetings  = new Map(); // meetingId -> { roster: Map<key, { zoomEmail?, participantUUID?, displayName, participantId? }> }
const boot = loadState();
for (const [mid, m] of Object.entries(boot.meetings || {})) {
  const map = new Map();
  for (const r of (m.roster || [])) {
    const email = (r.zoomEmail || '').trim().toLowerCase();
    const uuid  = (r.participantUUID || '').trim();
    const key   = email || uuid || Math.random().toString(16).slice(2);
    map.set(key, { zoomEmail: email || null, participantUUID: uuid || null, displayName: r.displayName || email || uuid || '', participantId: r.participantId || null });
  }
  meetings.set(mid, { roster: map });
}

// ------------------------ challenges (anti-replay) -----------------------
const challenges = new Map(); // challengeId -> { participantId, meetingId, issuedAt, ttlMs, used }
const CHALLENGE_TTL_MS = 30_000;
function newChallenge(participantId, meetingId) {
  const challengeId = crypto.randomBytes(6).toString('hex'); // 12 hex chars
  const issuedAt = Date.now();
  const rec = { participantId, meetingId, issuedAt, ttlMs: CHALLENGE_TTL_MS, used: false };
  challenges.set(challengeId, rec);
  setTimeout(() => challenges.delete(challengeId), CHALLENGE_TTL_MS + 5000);
  return { challengeId, issuedAt, ttlMs: CHALLENGE_TTL_MS };
}
function consumeChallenge(challengeId, participantId) {
  const rec = challenges.get(challengeId);
  if (!rec) return { ok:false, reason:'no_such_challenge' };
  if (rec.used) return { ok:false, reason:'already_used' };
  if (Date.now() > rec.issuedAt + rec.ttlMs) return { ok:false, reason:'expired' };
  if (rec.participantId !== participantId) return { ok:false, reason:'wrong_participant' };
  rec.used = true;
  return { ok:true };
}

// ------------------------ helpers ----------------------------------------
function safeSend(ws, obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }
function broadcastVerifiers(obj) { for (const v of verifiers) safeSend(v, obj); }
function publishRoster(ws = null) {
  const list = [...roster.values()];
  if (ws) safeSend(ws, { type: 'participants', list });
  else broadcastVerifiers({ type: 'participants', list });
}
function pushAllKeysTo(ws) {
  for (const [id, pem] of keys) safeSend(ws, { type: 'pubkey_pem', participantId: id, pem });
}
function sendFullMeetings(ws) {
  for (const [mid, data] of meetings) {
    safeSend(ws, { type: 'meeting_roster', meetingId: mid, roster: [...data.roster.values()] });
  }
}

// ------------------------ verify rate limiting ---------------------------
const verifyBuckets = new Map(); // key -> { tokens, lastAt }
function allowedVerify(meetingId, participantId) {
  const key = `${meetingId}:${participantId}`;
  const now = Date.now();
  const b = verifyBuckets.get(key) || { tokens: 3, lastAt: now };
  const refill = Math.floor((now - b.lastAt) / 5000); // +1 token per 5s
  if (refill > 0) { b.tokens = Math.min(3, b.tokens + refill); b.lastAt = now; }
  if (b.tokens <= 0) { verifyBuckets.set(key, b); return false; }
  b.tokens--; verifyBuckets.set(key, b); return true;
}
function randHex(nBytes=4){ return crypto.randomBytes(nBytes).toString('hex').toUpperCase(); }

// ------------------------ websocket handling -----------------------------
wss.on('connection', (ws) => {
  ws.isAlive = true;
  safeSend(ws, { type: 'hello', msg: 'TroofAI Hub online' });

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // --- demo auth ---
    if (msg.type === 'auth' && HUB_TOKEN) {
      if (msg.token !== HUB_TOKEN) { try { ws.close(); } catch{}; return; }
      ws.authed = true;
      return;
    }
    if (HUB_TOKEN && !ws.authed) return;

    // --- role: verifier (admin dashboard) ---
    if (msg.type === 'role' && msg.role === 'verifier') {
      ws.role = 'verifier';
      verifiers.add(ws);
      console.log('[role] verifier connected');
      publishRoster(ws);
      pushAllKeysTo(ws);
      sendFullMeetings(ws);
      return;
    }

    // --- role: sender (companion) ---
    if (msg.type === 'role' && msg.role === 'sender') {
      ws.role = 'sender';

      let participantId = msg.participantId || `p-${Math.random().toString(16).slice(2, 6)}`;
      let displayName   = msg.displayName || participantId;
      let enrolled      = false;

      // Meeting context
      ws.meetingId = msg.meetingId || null;
      ws.zoomEmail = (msg.zoomEmail || '').trim().toLowerCase();
      ws.participantUUID = (msg.participantUUID || '').trim();

      // Enroll code gates key registration + binds canonical ID
      if (msg.enrollCode && enrollCodes.has(msg.enrollCode)) {
        const rec = enrollCodes.get(msg.enrollCode);
        participantId = rec.id;
        displayName   = rec.displayName;
        enrolled      = true;
        console.log(`[enroll] ${participantId} via code ${msg.enrollCode}`);
      }

      ws.participantId = participantId;
      ws.displayName   = displayName;
      senders.set(participantId, ws);

      const info = { id: participantId, displayName, enrolled, hasKey: keys.has(participantId) };
      roster.set(participantId, info);
      broadcastVerifiers({ type: 'participant_join', info });

      if (!enrolled && keys.has(participantId)) {
        keys.delete(participantId);
        saveKeys(keys);
        broadcastVerifiers({ type: 'pubkey_clear', participantId });
        info.hasKey = false;
        roster.set(participantId, info);
        publishRoster();
      }

      // Presence binding: bind by UUID first, then by email
      if (ws.meetingId) {
        const mid = ws.meetingId;
        if (!meetings.has(mid)) meetings.set(mid, { roster: new Map() });
        const M = meetings.get(mid);

        let bound = false;
        // 1) UUID binding across existing roster rows
        if (ws.participantUUID) {
          for (const [k, r] of M.roster.entries()) {
            if (r.participantUUID && r.participantUUID === ws.participantUUID) {
              r.participantId = participantId;
              bound = true;
              break;
            }
          }
        }
        // 2) Email fallback (also create row if missing)
        if (!bound && ws.zoomEmail) {
          const emailKey = ws.zoomEmail;
          if (!M.roster.has(emailKey)) {
            M.roster.set(emailKey, { zoomEmail: emailKey, participantUUID: null, displayName: ws.displayName, participantId: null });
          }
          const entry = M.roster.get(emailKey);
          entry.participantId = participantId;
          bound = true;
        }

        if (bound) {
          broadcastVerifiers({ type: 'meeting_presence', meetingId: mid, zoomEmail: ws.zoomEmail || null, participantUUID: ws.participantUUID || null, participantId });
          saveState();
        }
      }

      console.log('[role] sender', participantId, displayName, 'enrolled=', enrolled, 'meeting=', ws.meetingId, 'email=', ws.zoomEmail, 'uuid=', ws.participantUUID);
      return;
    }

    // --- admin sets meeting roster (MERGE; bind to live senders by UUID/email) ---
    if (msg.type === 'set_meeting') {
      const mid = msg.meetingId;
      const prev = meetings.get(mid);
      const rosterMap = new Map();

      for (const r of (msg.roster || [])) {
        const email = (r.zoomEmail || '').trim().toLowerCase();
        const uuid  = (r.participantUUID || '').trim();
        const item = {
          zoomEmail: email || null,
          participantUUID: uuid || null,
          displayName: r.displayName || r.zoomEmail || r.participantUUID || '',
          participantId: null
        };

        // Preserve binding from previous roster
        if (prev?.roster) {
          for (const old of prev.roster.values()) {
            const emailMatch = email && old.zoomEmail === email;
            const uuidMatch  = uuid && old.participantUUID && old.participantUUID === uuid;
            if ((emailMatch || uuidMatch) && old.participantId) { item.participantId = old.participantId; break; }
          }
        }

        // Bind to any live sender with matching meeting + UUID/email
        for (const ws2 of senders.values()) {
          const uuidMatch  = uuid && ws2.participantUUID && ws2.participantUUID === uuid;
          const emailMatch = email && ws2.zoomEmail === email;
          if (ws2.meetingId === mid && (uuidMatch || emailMatch)) { item.participantId = ws2.participantId; break; }
        }

        const key = email || uuid || Math.random().toString(16).slice(2);
        rosterMap.set(key, item);
      }

      meetings.set(mid, { roster: rosterMap });
      broadcastVerifiers({ type: 'meeting_roster', meetingId: mid, roster: [...rosterMap.values()] });

      // Emit presence events for newly bound entries
      for (const item of rosterMap.values()) {
        if (item.participantId) {
          broadcastVerifiers({ type: 'meeting_presence', meetingId: mid, zoomEmail: item.zoomEmail || null, participantUUID: item.participantUUID || null, participantId: item.participantId });
        }
      }

      saveState();
      return;
    }

    // --- dev: reset all keys (useful in demos) ---
    if (msg.type === 'reset_keys') {
      keys.clear(); saveKeys(keys);
      for (const [id] of roster) broadcastVerifiers({ type: 'pubkey_clear', participantId: id });
      console.log('[keys] reset');
      return;
    }

    // --- key registration (PEM SPKI) ---
    if (msg.type === 'register_pubkey' && ws.role === 'sender') {
      const id  = ws.participantId;
      const rec = roster.get(id);
      if (!rec || !rec.enrolled) { safeSend(ws, { type: 'enroll_required' }); return; }

      if (msg.pem) {
        keys.set(id, msg.pem);
        saveKeys(keys);
        rec.hasKey = true;
        roster.set(id, rec);
        publishRoster();
        broadcastVerifiers({ type: 'pubkey_pem', participantId: id, pem: msg.pem });
        console.log('[key] registered for', id);
      }
      return;
    }

    // --- roster fetch ---
    if (msg.type === 'participants_request') {
      publishRoster(ws);
      return;
    }

    // --- signaling relay (future) ---
    if (msg.type === 'signal') {
      if (msg.to === 'verifier') {
        broadcastVerifiers({ type: 'signal', participantId: msg.participantId, direction: msg.direction, payload: msg.payload });
      } else if (msg.to === 'sender') {
        const t = senders.get(msg.participantId);
        if (t) safeSend(t, { type: 'signal', direction: msg.direction, payload: msg.payload });
      }
      return;
    }

    // --- verify command (hub mints challenge) ---
    if (msg.type === 'verify_now') {
      const mid = msg.meetingId ?? msg.payload?.meetingId ?? null;
      let targetId = msg.participantId || null;

      if (msg.by === 'participantUUID') {
        const uuid = (msg.participantUUID || '').trim();

        // Try meetings roster
        const M = meetings.get(mid);
        if (M) {
          for (const r of M.roster.values()) {
            if (r.participantUUID && r.participantUUID === uuid) { targetId = r.participantId || null; break; }
          }
        }
        // Fallback: scan live senders
        if (!targetId) {
          for (const ws2 of senders.values()) {
            if (ws2.meetingId === mid && ws2.participantUUID === uuid) { targetId = ws2.participantId; break; }
          }
        }
        console.log('[verify_by_uuid]', { mid, uuid, chosenPid: targetId || null });
      } else if (msg.by === 'zoomEmail') {
        const email = (msg.zoomEmail || '').trim().toLowerCase();

        const M = meetings.get(mid);
        let entry = null;
        if (M) {
          for (const r of M.roster.values()) { if (r.zoomEmail && r.zoomEmail === email) { entry = r; break; } }
        }
        targetId = entry?.participantId || null;

        // Fallback: scan live senders
        if (!targetId) {
          for (const ws2 of senders.values()) {
            if ((ws2.meetingId || null) === mid && (ws2.zoomEmail || '') === email) {
              targetId = ws2.participantId;
              break;
            }
          }
        }
        console.log('[verify_by_email]', { mid, email, chosenPid: targetId || null });
      } else {
        console.log('[verify_by_pid]', { mid, participantId: targetId || null });
      }

      const t = targetId ? senders.get(targetId) : null;
      if (!t) {
        console.warn('[verify] no route', { by: msg.by, meetingId: mid, zoomEmail: msg.zoomEmail, participantUUID: msg.participantUUID, targetId });
        return;
      }

      if (!allowedVerify(mid, targetId)) {
        safeSend(t, { type: 'too_many_requests' });
        broadcastVerifiers({ type:'rate_limited', participantId: targetId, meetingId: mid });
        return;
      }

      const { challengeId, issuedAt, ttlMs } = newChallenge(targetId, mid);
      const n = randHex(4); // 8 hex chars
      const pattern = Math.random() < 0.5 ? 'A' : 'B';

      const payload = {
        meetingId: mid,
        participantId: targetId,
        challengeId,
        n,
        issuedAt,
        ttlMs,
        pattern
      };

      console.log('[verify] →', { targetId, meetingId: mid, n, challengeId });
      safeSend(t, { type: 'verify_now', participantId: targetId, payload });
      return;
    }

    // --- sidecar forwarding with server-side challenge checks ---
    if (msg.type === 'sidecar') {
      const sc = msg.payload || {};
      const pid = msg.participantId;

      if (sc.challengeId) {
        const consumed = consumeChallenge(sc.challengeId, pid);
        if (!consumed.ok) {
          broadcastVerifiers({ type: 'challenge_violation', participantId: pid, reason: consumed.reason, payload: sc });
          return;
        }
      }

      broadcastVerifiers({ type: 'sidecar', participantId: pid, payload: sc });
      return;
    }

    // --- verification result echo (for multi-verifier UIs) ---
    if (msg.type === 'verification_result') {
      broadcastVerifiers(msg);
      return;
    }
  });

  ws.on('close', () => {
    if (ws.role === 'verifier') verifiers.delete(ws);
    if (ws.role === 'sender') {
      const id = ws.participantId;
      if (id) {
        senders.delete(id);
        roster.delete(id);
        broadcastVerifiers({ type: 'participant_leave', participantId: id });
      }
    }
  });
});

// ------------------------ heartbeat to drop dead sockets ------------------
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; try { ws.ping(); } catch {}
  });
}, 30000);

// ------------------------ graceful shutdown ------------------------------
process.on('SIGINT', () => {
  console.log('\n[hub] shutting down');
  try { wss.close(); } catch {}
  process.exit(0);
});