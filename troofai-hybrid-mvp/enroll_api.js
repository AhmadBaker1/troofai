// enroll_api.js
// Run with: npm run enroll
// Demo enrollment API that verifies a (demo) SSO token, accepts a TPM/SE public key,
// and stores a device record per (companyId, userId, deviceId).

import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const app = express();
app.use(express.json());

// Simple CORS for local dev
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const DB_PATH = './enrollments.json';
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { devices: [] }; }
}
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

// DEMO SSO verification (replace with real OIDC/JWKS in prod)
function verifySSO(token) {
  // For demo, accept HS256 with a shared secret
  const SECRET = process.env.SSO_DEMO_SECRET || 'dev-shared-secret';
  const claims = jwt.verify(token, SECRET); // throws if invalid
  // Expect: { sub:'user-id', email, name, company_id:'tenant-id' }
  if (!claims?.sub || !claims?.company_id) throw new Error('Missing required claims');
  return {
    userId: claims.sub,
    email: claims.email || null,
    displayName: claims.name || claims.email || claims.sub,
    companyId: claims.company_id,
  };
}

// Short keyId from PEM
function keyIdFromPem(pem) {
  const derB64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const raw = Buffer.from(derB64, 'base64');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

// POST /enroll  body: { ssoToken, device:{platform,model,serial}, pubkey_pem, attestation? }
app.post('/enroll', (req, res) => {
  try {
    const { ssoToken, device, pubkey_pem, attestation } = req.body || {};
    if (!ssoToken || !pubkey_pem) return res.status(400).json({ error: 'missing token or pubkey' });

    const subject = verifySSO(ssoToken); // { companyId, userId, email, displayName }
    const keyId = keyIdFromPem(pubkey_pem);
    const deviceId = device?.serial || `dev-${crypto.randomBytes(4).toString('hex')}`;

    const db = loadDB();
    const idx = db.devices.findIndex(
      d => d.companyId === subject.companyId && d.userId === subject.userId && d.deviceId === deviceId
    );

    const rec = {
      companyId: subject.companyId,
      userId: subject.userId,
      email: subject.email,
      displayName: subject.displayName,
      deviceId,
      platform: device?.platform || null,
      model: device?.model || null,
      publicKeyPem: pubkey_pem,
      keyId,
      attestation: attestation || null,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (idx >= 0) db.devices[idx] = { ...db.devices[idx], ...rec, updatedAt: Date.now() };
    else db.devices.push(rec);
    saveDB(db);

    // We’ll use "companyId:userId" as our canonical participantId for this device owner
    const participantId = `${subject.companyId}:${subject.userId}`;
    return res.json({ ok: true, participantId, keyId, deviceId });
  } catch (e) {
    console.error('[enroll]', e);
    return res.status(400).json({ error: e.message || 'enroll failed' });
  }
});

const PORT = process.env.ENROLL_PORT || 8788;
app.listen(PORT, () => console.log(`[Enroll API] http://127.0.0.1:${PORT}`));