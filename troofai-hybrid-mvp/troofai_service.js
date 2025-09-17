import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';

const SVC_PORT = process.env.SVC_PORT || 8787;
const KEY_PATH = './service_key.pem';
const PUB_PATH = './service_pub.pem';

function ensureKeys() {
  if (fs.existsSync(KEY_PATH) && fs.existsSync(PUB_PATH)) return;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); // P-256
  fs.writeFileSync(KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(PUB_PATH, publicKey.export({ type: 'spki', format: 'pem' }));
}
function getPriv() { return crypto.createPrivateKey(fs.readFileSync(KEY_PATH)); }
function getPub() { return fs.readFileSync(PUB_PATH, 'utf8'); }
function keyFingerprint(pem) {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g,'').replace(/\s+/g,''), 'base64');
  return crypto.createHash('sha256').update(der).digest('hex').slice(0,16);
}

// Simulated “golden state” (PCR-like) for demo integrity signal
const GOLDEN = crypto.createHash('sha256')
  .update(JSON.stringify({ plat: os.platform(), arch: os.arch(), node: process.versions.node }))
  .digest('hex');

ensureKeys();

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*'
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
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }

  if (req.url === '/health') return json(res, 200, { ok: true });
  if (req.url === '/pubkey') {
    const pem = getPub();
    return json(res, 200, { pem, keyId: keyFingerprint(pem), alg: 'ES256', golden: GOLDEN });
  }

  if (req.url === '/sign' && req.method === 'POST') {
    const body = await parseBody(req);
    const canonical = body.canonical || '';
    try {
      const signer = crypto.createSign('SHA256');
      signer.update(Buffer.from(canonical, 'utf8')); signer.end();
      const sigDer = signer.sign(getPriv()); // DER-encoded ECDSA
      const pem = getPub();
      const keyId = keyFingerprint(pem);
      return json(res, 200, { sigHex: sigDer.toString('hex'), keyId, alg: 'ES256' });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(SVC_PORT, () => console.log(`[TroofAI Service] http://127.0.0.1:${SVC_PORT}`));