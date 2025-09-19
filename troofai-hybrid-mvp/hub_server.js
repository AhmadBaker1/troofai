// hub_server.js — displayName-based binding (no Zoom Dashboard needed)
import { WebSocketServer } from 'ws';
import fs from 'fs';
import crypto from 'crypto';

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });
const MEETING_TTL_MS = 2 * 60 * 1000;
console.log(`[TroofAI Hub] ws://127.0.0.1:${PORT}`);


// ---------- persistence ----------
const KEYS_PATH = './keys.json';
function loadKeys() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(KEYS_PATH,'utf8')))); }
  catch { return new Map(); }
}
function saveKeys(map) { fs.writeFileSync(KEYS_PATH, JSON.stringify(Object.fromEntries(map), null, 2)); }

const HUB_STATE_PATH = './hub_state.json';
function loadState() {
  try { return JSON.parse(fs.readFileSync(HUB_STATE_PATH,'utf8')); }
  catch { return { meetings: {} }; }
}
function saveState() {
  const out = {};
  for (const [mid, data] of meetings) out[mid] = { roster: [...data.roster.values()], lastSet: data.lastSet };
  fs.writeFileSync(HUB_STATE_PATH, JSON.stringify({ meetings: out }, null, 2));
}

// ---------- state ----------
const senders   = new Map(); // participantId -> ws
const verifiers = new Set(); // ws set
const roster    = new Map(); // participantId -> { id, displayName, hasKey }
const keys      = loadKeys(); // participantId -> publicPem
const meetings  = new Map();  // meetingId -> { roster: Map<dnLower, { displayName, participantId? }>, lastSet }

const init = loadState();
if (init.meetings) {
  for (const [mid, data] of Object.entries(init.meetings)) {
    const m = new Map();
    for (const r of (data.roster || [])) m.set((r.displayName||'').toLowerCase(), r);
    meetings.set(mid, { roster: m, lastSet: data.lastSet || Date.now() });
  }
}

// ---------- helpers ----------
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
function bindIfDisplayNameMatches(mid, dnLower, pid) {
  const M = meetings.get(mid); if (!M) return false;
  const entry = M.roster.get(dnLower); if (!entry) return false;
  if (entry.participantId === pid) return true;
  entry.participantId = pid;
  broadcastVerifiers({ type: 'meeting_presence', meetingId: mid, displayName: entry.displayName, participantId: pid });
  return true;
}

// simple token bucket per participant for verify rate limit
const buckets = new Map(); // id -> { tokens, ts }
function allow(id) {
  const now = Date.now();
  const cap = 4, refillMs = 2500;
  let b = buckets.get(id) || { tokens: cap, ts: now };
  if (now - b.ts > refillMs) { b.tokens = Math.min(cap, b.tokens + Math.floor((now - b.ts)/refillMs)); b.ts = now; }
  if (b.tokens <= 0) return false;
  b.tokens -= 1; buckets.set(id, b); return true;
}

// ---------- websocket ----------
wss.on('connection', (ws) => {
  ws.isAlive = true;
  safeSend(ws, { type: 'hello', msg: 'TroofAI Hub online' });
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

    // --- verifier (Admin or ZoomBridge) ---
    if (msg.type === 'role' && msg.role === 'verifier') {
      ws.role = 'verifier'; verifiers.add(ws);
      publishRoster(ws); pushAllKeysTo(ws); sendFullMeetings(ws);
      return;
    }

    // --- hard reset a meeting roster (from Admin or ZoomBridge) ---
    // { type:'reset_meeting', meetingId }
    if (msg.type === 'reset_meeting') {
      const mid = String(msg.meetingId || '');
      if (!mid) return;

      // clear the roster for this meeting and broadcast empty list
      meetings.set(mid, { roster: new Map(), lastSet: Date.now() });
      broadcastVerifiers({ type: 'meeting_roster', meetingId: mid, roster: [] });
      saveState();
      return;
    }

    // { type:'meeting_context', meetingId }
    if (msg.type === 'meeting_context') {
      const mid = String(msg.meetingId || '');
      if (!mid) return;

      // remember last context if you want (optional)
      // then broadcast to ALL clients (verifiers + senders)
      for (const client of wss.clients) {
        safeSend(client, { type: 'meeting_context', meetingId: mid });
      }
      return;
    }

    // --- sender (Companion) ---
    if (msg.type === 'role' && msg.role === 'sender') {
      ws.role = 'sender';

      const participantId = msg.participantId || `p-${Math.random().toString(16).slice(2, 6)}`;
      const displayName   = msg.displayName || participantId;
      const dnLower       = (msg.zoomDisplayName || displayName).toLowerCase();

      ws.meetingId        = msg.meetingId || null;
      ws.zoomDisplayName  = dnLower;
      ws.participantId    = participantId;
      ws.displayName      = displayName;

      senders.set(participantId, ws);

      const info = {
        id: participantId,
        displayName,
        hasKey: keys.has(participantId)
      };
      roster.set(participantId, info);
      broadcastVerifiers({ type: 'participant_join', info });

      // auto-bind by display name if present
      if (ws.meetingId && dnLower) bindIfDisplayNameMatches(ws.meetingId, dnLower, participantId);
      return;
    }

    // --- dev helpers ---
    if (msg.type === 'reset_keys') {
      keys.clear(); saveKeys(keys);
      for (const [id] of roster) broadcastVerifiers({ type: 'pubkey_clear', participantId: id });
      return;
    }

    // --- register pubkey ---
    if (msg.type === 'register_pubkey' && ws.role === 'sender') {
      const id = ws.participantId;
      if (msg.pem) {
        keys.set(id, msg.pem); saveKeys(keys);
        const rec = roster.get(id) || { id, displayName: ws.displayName };
        rec.hasKey = true; roster.set(id, rec);
        publishRoster();
        broadcastVerifiers({ type: 'pubkey_pem', participantId: id, pem: msg.pem });
      }
      return;
    }

    // --- set meeting roster (from ZoomBridge/Admin) ---
    // { type:'set_meeting', meetingId, roster:[ { displayName } ] }
    if (msg.type === 'set_meeting') {
      const mid = msg.meetingId;
      const rosterMap = new Map();
      for (const r of (msg.roster || [])) {
        const dn = (r.displayName || '').trim();
        if (!dn) continue;
        const key = dn.toLowerCase();
        rosterMap.set(key, { displayName: dn, participantId: null });
      }
      meetings.set(mid, { roster: rosterMap, lastSet: Date.now() });

      // bind any already-connected senders
      for (const [, s] of senders) {
        if (s.meetingId === mid && s.zoomDisplayName) bindIfDisplayNameMatches(mid, s.zoomDisplayName, s.participantId);
      }

      broadcastVerifiers({ type: 'meeting_roster', meetingId: mid, roster: [...rosterMap.values()] });
      saveState();
      return;
    }

    // --- optional manual bind by displayName (Admin) ---
    // { type:'bind_attendee', meetingId, displayName, participantId }
    if (msg.type === 'bind_attendee') {
      const mid = msg.meetingId;
      const key = (msg.displayName || '').toLowerCase();
      const pid = msg.participantId;
      if (!mid || !key || !pid) return;
      bindIfDisplayNameMatches(mid, key, pid);
      saveState();
      return;
    }

    // --- verify_now ---
    // { type:'verify_now', by:'displayName'|'participantId', meetingId, displayName, participantId, payload:{ n, ts, pattern, meetingId, challengeId? } }
    if (msg.type === 'verify_now') {
      let targetId = msg.participantId || null;

      if (msg.by === 'displayName') {
        const M = meetings.get(msg.meetingId);
        const entry = M?.roster.get((msg.displayName || '').toLowerCase());
        targetId = entry?.participantId || null;
      }

      const t = targetId ? senders.get(targetId) : null;
      if (!t) return;
      if (!allow(targetId)) return;

      const payload = {
        ...msg.payload,
        meetingId: msg.meetingId || t.meetingId || null,
        challengeId: msg.payload?.challengeId || crypto.randomBytes(8).toString('hex')
      };

      safeSend(t, { type: 'verify_now', participantId: targetId, payload });
      return;
    }

    // --- signed sidecar from Companion ---
    if (msg.type === 'sidecar') {
      broadcastVerifiers({ type: 'sidecar', participantId: msg.participantId, payload: msg.payload });
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

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; try { ws.ping(); } catch {}
  });
}, 30000);

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [mid, data] of meetings) {
    // if the roster hasn't been updated recently, clear it
    if ((now - (data.lastSet || 0)) > MEETING_TTL_MS) {
      meetings.set(mid, { roster: new Map(), lastSet: now });
      broadcastVerifiers({ type: 'meeting_roster', meetingId: mid, roster: [] });
      changed = true;
    }
  }
  if (changed) saveState();
}, 30000);