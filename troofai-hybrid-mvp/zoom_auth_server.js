// zoom_auth_server.js
// Run: node zoom_auth_server.js
// Env needed:
//   ZOOM_SDK_KEY=xxxx
//   ZOOM_SDK_SECRET=xxxx
//   ZOOM_AUTH_PORT=8888  (optional)
//   ZOOM_ROLE=0|1        (optional; 1=host, 0=attendee)

import express from 'express';
import crypto from 'crypto';
import 'dotenv/config';


const SDK_KEY    = process.env.ZOOM_SDK_KEY;
const SDK_SECRET = process.env.ZOOM_SDK_SECRET;
const PORT       = process.env.ZOOM_AUTH_PORT || 8888;
const ROLE       = Number(process.env.ZOOM_ROLE ?? 0);

if (!SDK_KEY || !SDK_SECRET) {
  console.error('[zoom-auth] Missing ZOOM_SDK_KEY/ZOOM_SDK_SECRET in env');
  process.exit(1);
}

const app = express();

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  next();
});

// GET /zoom-auth?mn=<meetingNumber>&role=0|1
app.get('/zoom-auth', (req, res) => {
  try {
    const meetingNumber = String(req.query.mn || '').trim();
    if (!meetingNumber) return res.status(400).send('missing mn');

    const role = Number(req.query.role ?? ROLE);
    const iat  = Math.floor(Date.now() / 1000) - 30;
    const exp  = iat + 2 * 60 * 60; // 2 hours

    const headerB64  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify({
      sdkKey: SDK_KEY,
      mn: meetingNumber,
      role,
      iat, exp, tokenExp: exp
    })).toString('base64url');

    const toSign = `${headerB64}.${payloadB64}`;
    const sig    = crypto.createHmac('sha256', SDK_SECRET).update(toSign).digest('base64url');
    const jwt    = `${toSign}.${sig}`;

    res.type('text/plain').send(jwt);
  } catch (e) {
    console.error('[zoom-auth] error:', e);
    res.status(500).send('error generating signature');
  }
});

app.listen(PORT, () => {
  console.log(`[zoom-auth] http://127.0.0.1:${PORT}/zoom-auth?mn=<meetingNumber>`);
});