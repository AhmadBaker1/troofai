// zoom_poller.js
// Run: node zoom_poller.js <meetingNumberOrUUID>
// Needs: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET in .env
import 'dotenv/config';
import WebSocket from 'ws';

const {
  ZOOM_ACCOUNT_ID,
  ZOOM_CLIENT_ID,
  ZOOM_CLIENT_SECRET,
  HUB_URL = 'ws://127.0.0.1:8080',
  ZOOM_POLL_INTERVAL_MS = '5000',
} = process.env;

const INPUT_ID = process.argv[2] || process.env.ZOOM_MEETING_ID;

if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
  console.error('[poller] Missing ZOOM_ACCOUNT_ID/ZOOM_CLIENT_ID/ZOOM_CLIENT_SECRET in .env');
  process.exit(1);
}
if (!INPUT_ID) {
  console.error('[poller] Provide meeting number/UUID: node zoom_poller.js <meetingId>');
  process.exit(1);
}

// ---------- Zoom helpers ----------
async function getAccessToken() {
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(ZOOM_ACCOUNT_ID)}`;
  const basic = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
  if (!r.ok) throw new Error(`token HTTP ${r.status}`);
  const j = await r.json();
  return j.access_token;
}

// Return the live meeting UUID for a given input (number or uuid)
// Strategy:
// 1) List live meetings: GET /v2/metrics/meetings?type=live&page_size=300
// 2) Try to match by numeric meeting id OR by uuid (string compare)
// 3) If found, return its uuid; else null
async function resolveLiveUUID(token, input) {
  const url = `https://api.zoom.us/v2/metrics/meetings?type=live&page_size=300`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    throw new Error(`resolve list HTTP ${r.status}`);
  }
  const j = await r.json();
  const items = Array.isArray(j.meetings) ? j.meetings : [];

  const isNumeric = /^\d{8,}$/.test(String(input));
  let match = null;

  // Normalize comparisons
  const inputStr = String(input).trim();
  for (const m of items) {
    // m.id is number, m.uuid is string; sometimes m.id is meeting number
    const midStr = String(m.id ?? '').trim();
    const uuidStr = String(m.uuid ?? '').trim();
    if (isNumeric) {
      if (midStr === inputStr) { match = m; break; }
    } else {
      if (uuidStr === inputStr) { match = m; break; }
    }
  }

  if (!match) {
    console.warn('[poller] live meeting not found in dashboard list. Is the meeting live and under your account?');
    return null;
  }
  return match.uuid; // IMPORTANT: participants endpoint prefers UUID for live meeting
}

async function fetchLiveParticipants(token, meetingUUID) {
  // UUIDs often contain '/', must be URL-encoded
  const encUUID = encodeURIComponent(meetingUUID);
  const url = `https://api.zoom.us/v2/metrics/meetings/${encUUID}/participants?type=live&page_size=300`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return [];
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`participants HTTP ${r.status}${text ? ` – ${text}` : ''}`);
  }
  const j = await r.json();
  const items = (j.participants || []).map(p => ({
    email: (p.user_email || '').toLowerCase(),
    displayName: p.user_name || p.user_email || 'Participant',
  }));
  const dedup = new Map();
  for (const it of items) {
    if (!it.email) continue; // Zoom may omit emails if meeting allows anonymous/unauthenticated
    if (!dedup.has(it.email)) dedup.set(it.email, it);
  }
  return [...dedup.values()];
}

// ---------- Hub WS ----------
let ws;
function ensureHub() {
  return new Promise((resolve) => {
    if (ws && ws.readyState === 1) return resolve(ws);
    ws = new WebSocket(HUB_URL);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'role', role: 'verifier' }));
      resolve(ws);
    });
    ws.on('error', () => {});
  });
}

async function pushRosterToHub(meetingUUID, roster) {
  const sock = await ensureHub();
  // We’ll use the UUID as the hub meetingId. Keep it consistent with Admin/Companion if you prefer a custom id.
  sock.send(JSON.stringify({ type: 'set_meeting', meetingId: meetingUUID, roster }));
}

// ---------- Main loop ----------
let cachedUUID = null;

async function loop() {
  try {
    const token = await getAccessToken();

    // Resolve UUID once, then reuse; re-resolve if not found
    if (!cachedUUID) {
      const u = await resolveLiveUUID(token, INPUT_ID);
      if (!u) {
        console.log('[poller] waiting for live meeting…');
        setTimeout(loop, parseInt(ZOOM_POLL_INTERVAL_MS, 10) || 5000);
        return;
      }
      cachedUUID = u;
      console.log('[poller] resolved live UUID:', cachedUUID);
    }

    const roster = await fetchLiveParticipants(token, cachedUUID);
    if (roster.length > 0) {
      await pushRosterToHub(cachedUUID, roster);
      console.log(`[poller] pushed ${roster.length} email(s) for meeting ${cachedUUID}`);
    } else {
      console.log('[poller] no participant emails returned (enable “Only authenticated users can join”, or registration)');
    }
  } catch (e) {
    console.error('[poller] error', e.message);
    // If participants 400 due to UUID issues, drop cache so we re-resolve:
    if (String(e.message).includes('participants HTTP 400')) cachedUUID = null;
  } finally {
    setTimeout(loop, parseInt(ZOOM_POLL_INTERVAL_MS, 10) || 5000);
  }
}

console.log(`[poller] starting for input=${INPUT_ID} → Hub ${HUB_URL}`);
loop();