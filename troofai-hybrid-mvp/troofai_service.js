// troofai_service.js
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

ensureKeys();

// Create a stable "device state" hash (demo only)
function getDemoQuote() {
  const fingerprint = [
    os.platform(),
    os.arch(),
    process.versions.node,
    crypto.createHash('sha256').update(getPub()).digest('hex').slice(0, 16) // tie to this key
  ].join('|');

  return crypto.createHash('sha256').update(fingerprint).digest('hex'); // 64 hex chars
}

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
  if (req.method === 'OPTIONS') { 
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); 
    return res.end(); 
  }

  if (req.url === '/health') return json(res, 200, { ok: true });
  if (req.url === '/pubkey') return json(res, 200, { pem: getPub() });
  if (req.url === '/quote') return json(res, 200, { quote: getDemoQuote() });

  if (req.url === '/sign' && req.method === 'POST') {
    const body = await parseBody(req);
    const canonical = body.canonical || '';
    try {
      const signer = crypto.createSign('SHA256');
      signer.update(Buffer.from(canonical, 'utf8'));
      signer.end();
      const sigDer = signer.sign(getPriv()); // DER-encoded ECDSA
      return json(res, 200, { sigHex: sigDer.toString('hex') });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(SVC_PORT, () => console.log(`[TroofAI Service] http://127.0.0.1:${SVC_PORT}`));