// enroll_api.js
// Run: npm run enroll  (see package.json scripts)
// Simple demo "SSO → store TPM pubkey" endpoint.
// Accepts JSON: { corporateEmail, participantId, displayName, pubkeyPem }
// If SSO_DEMO_SECRET is set in .env, require header:  x-sso-secret: <same value>

import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import 'dotenv/config';

const PORT = process.env.ENROLL_PORT || 8788;
const SSO_DEMO_SECRET = process.env.SSO_DEMO_SECRET || ''; // if set, header must match

const DB_PATH = './enroll_store.json';
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { devices: [] }; }
}
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
}
function parseBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, { ok: true });

  if (req.url === '/health') return send(res, 200, { ok: true });

  if (req.url === '/enroll' && req.method === 'POST') {
    // Optional shared-secret check
    if (SSO_DEMO_SECRET) {
      const hdr = req.headers['x-sso-secret'] || '';
      if (hdr !== SSO_DEMO_SECRET) return send(res, 400, { error: 'bad_secret' });
    }

    const body = await parseBody(req);
    const { corporateEmail, participantId, displayName, pubkeyPem } = body || {};

    // Validate inputs
    if (!corporateEmail || !/@/.test(corporateEmail)) return send(res, 400, { error: 'invalid_email' });
    if (!participantId || typeof participantId !== 'string') return send(res, 400, { error: 'invalid_participantId' });
    if (!pubkeyPem || !/BEGIN PUBLIC KEY/.test(pubkeyPem)) return send(res, 400, { error: 'invalid_pubkey' });

    // Derive simple identifiers
    const keyId = crypto.createHash('sha256').update(pubkeyPem).digest('hex').slice(0, 12);
    // For demo, synthesize a device id; in prod you’d read a real device serial attested by TPM
    const deviceId = 'demo-' + crypto.randomBytes(4).toString('hex');

    // Persist (append/update)
    const db = loadDB();
    const existingIdx = db.devices.findIndex(d => d.participantId === participantId);
    const rec = { corporateEmail, participantId, displayName: displayName || '', keyId, deviceId, pubkeyPem, enrolledAt: Date.now() };
    if (existingIdx >= 0) db.devices[existingIdx] = rec; else db.devices.push(rec);
    saveDB(db);

    return send(res, 200, { ok: true, participantId, keyId, deviceId });
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => console.log(`[enroll] listening on http://127.0.0.1:${PORT}`));