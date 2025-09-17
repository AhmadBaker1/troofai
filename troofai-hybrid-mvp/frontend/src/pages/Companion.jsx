import React, { useRef, useState } from 'react';

const HEADLESS = true; // no camera/WebRTC
const HUB_URL = import.meta.env.VITE_HUB_URL || 'ws://127.0.0.1:8080';
const SERVICE_URL = import.meta.env.VITE_SERVICE_URL || 'http://127.0.0.1:8787';
const ENROLL_URL = import.meta.env.VITE_ENROLL_URL || 'http://127.0.0.1:8788/enroll';

export default function Companion() {
  const [wsState, setWsState] = useState('Disconnected');

  // Identity / meeting context
  const [id, setId] = useState('acme:ciso'); // will be set by enroll() response
  const [name, setName] = useState('CISO (Maya)');
  const [code, setCode] = useState('CISO-2025'); // still usable for demo fallback
  const [meetingId, setMeetingId] = useState('mtg-123');
  const [zoomEmail, setZoomEmail] = useState('maya.ciso@company.com');
  const [participantUUID, setParticipantUUID] = useState(''); // optional: paste from ZoomBridge for perfect binding

  const [log, setLog] = useState([]);
  const wsRef = useRef(null);
  const stateRef = useRef({
    pending: null,   // { meetingId, pattern, n, ts }
    pubPem: null,
    retry: 0,
    closed: false,
  });

  function push(msg) {
    setLog(x => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...x].slice(0, 300));
  }

  async function demoSSOToken(companyId='acme', userId='ciso', email='maya.ciso@company.com', displayName='CISO (Maya)') {
  // HS256 sign using Web Crypto (demo only; do NOT do this in prod)
  const enc = new TextEncoder();
  const secret = import.meta.env.VITE_SSO_DEMO_SECRET || 'dev-shared-secret';

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: userId,
    email,
    name: displayName,
    company_id: companyId,
    iat: Math.floor(Date.now()/1000)
  };

  const b64url = (objOrBytes) => {
    const bytes = objOrBytes instanceof Uint8Array ? objOrBytes : enc.encode(JSON.stringify(objOrBytes));
    let str = btoa(String.fromCharCode(...bytes));
    return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
  };

  const data = `${b64url(header)}.${b64url(payload)}`;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  const sigB64u = b64url(new Uint8Array(sig));
  return `${data}.${sigB64u}`;
}

  // --- WS connect with simple backoff
  function connectWS() {
    stateRef.current.closed = false;
    open();
  }

  function open() {
    const ws = new WebSocket(HUB_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsState('Connected');
      stateRef.current.retry = 0;
      push('WS connected');

      // Announce as sender with current identity
      ws.send(JSON.stringify({
        type: 'role', role: 'sender',
        participantId: id, displayName: name,
        enrollCode: code || null,
        meetingId, zoomEmail,
        participantUUID: participantUUID || null
      }));

      // Register device public key from local service (TPM/SE mock)
      registerPubKey();
    };

    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data) } catch { return; }

      if (msg.type === 'verify_now' && msg.participantId === id) {
        const v = msg.payload || {};
        push(`VERIFY n=${v.n} pat=${v.pattern} mtg=${v.meetingId}`);
        stateRef.current.pending = { meetingId: v.meetingId, pattern: v.pattern, n: v.n, ts: v.ts, challengeId: v.challengeId };
        if (HEADLESS) sendSidecarOnce();
      }

      if (msg.type === 'enroll_required') {
        push('Enrollment required to register key (use a valid code or run Enroll).');
      }
    };

    ws.onerror = () => {
      try { ws.close(); } catch {}
    };

    ws.onclose = () => {
      setWsState('Disconnected');
      if (stateRef.current.closed) return;
      const delay = Math.min(1000 * (2 ** (stateRef.current.retry++)), 10000);
      push(`WS disconnected — reconnecting in ${Math.round(delay/1000)}s`);
      setTimeout(open, delay);
    };
  }

  function closeWS() {
    stateRef.current.closed = true;
    try { wsRef.current?.close(); } catch {}
  }

  // --- Local device service (TPM/SE mock)
  async function registerPubKey() {
    try {
      const r = await fetch(`${SERVICE_URL}/pubkey`);
      const j = await r.json();
      stateRef.current.pubPem = j.pem;
      push('Got pubkey from local service');

      // Send to hub so Admin can verify signatures
      wsRef.current?.send(JSON.stringify({ type: 'register_pubkey', pem: j.pem }));
    } catch (e) {
      push('Error fetching pubkey: ' + e.message);
    }
  }

  // --- Enroll with SSO + TPM pubkey -> store in DB and set participantId
  async function enroll() {
    try {
      // 1) ensure we have a public key
      const r = await fetch(`${SERVICE_URL}/pubkey`);
      const { pem } = await r.json();
      stateRef.current.pubPem = pem;

      // 2) demo SSO token (company: acme, user: ciso)
      const token = await demoSSOToken('acme', 'ciso', zoomEmail || 'maya.ciso@company.com', name || 'CISO (Maya)');

      // 3) POST to Enroll API
      const body = {
        ssoToken: token,
        device: { platform: navigator.platform, model: 'demo', serial: 'demo-serial-001' },
        pubkey_pem: pem,
        attestation: { mock: true, os: navigator.userAgent }
      };
      const resp = await fetch(ENROLL_URL, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body) });
      const ej = await resp.json();
      if (!resp.ok) throw new Error(ej.error || 'enroll failed');

      // 4) update our identity to the returned participantId (e.g., "acme:ciso")
      setId(ej.participantId);
      push(`Enrolled: participantId=${ej.participantId}, keyId=${ej.keyId}, deviceId=${ej.deviceId}`);

      // 5) tell hub our (possibly new) identity; then register pubkey again (id changed)
      wsRef.current?.send(JSON.stringify({
        type: 'role', role: 'sender',
        participantId: ej.participantId, displayName: name,
        meetingId, zoomEmail,
        participantUUID: participantUUID || null
      }));
      wsRef.current?.send(JSON.stringify({ type: 'register_pubkey', pem }));

    } catch (e) {
      push('Enroll error: ' + e.message);
    }
  }

  async function sendSidecarOnce() {
    const p = stateRef.current.pending; if (!p) return;

    const mtg = p.meetingId || meetingId;
    const canonical = [
      mtg,
      id,
      p.challengeId || '',
      p.n || '',
      String(p.ts || ''),
      p.pattern || '',
      'golden:demo-baseline' // mock posture field; real attestation would go here
    ].join('|');

    try {
      const resp = await fetch(`${SERVICE_URL}/sign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canonical })
      });
      if (!resp.ok) throw new Error(`sign HTTP ${resp.status}`);
      const { sigHex } = await resp.json();

      wsRef.current?.send(JSON.stringify({
        type: 'sidecar',
        participantId: id,
        payload: {
          meetingId: mtg,
          n: p.n, ts: p.ts, pattern: p.pattern,
          challengeId: p.challengeId || null,
          sigHex, alg: 'ECDSA-P256-DER',
          keyId: stateRef.current.pubPem ? undefined : undefined, // optional
          golden: 'golden:demo-baseline',
          issuedAt: Date.now(),
          ttlMs: 1500
        }
      }));
      push(`Sidecar sent n=${p.n}`);
    } catch (e) {
      push('Sign error: ' + e.message);
    } finally {
      stateRef.current.pending = null;
    }
  }

  async function checkService() {
    try {
      const r = await fetch(`${SERVICE_URL}/health`);
      const j = await r.json();
      push(`Service health: ${JSON.stringify(j)}`);
    } catch (e) {
      push('Service health error: ' + e.message);
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="dot" /> TroofAI Companion</div>
        <div className="muted">WS: {wsState}</div>
      </header>

      <main className="content">
        <div className="card">
          <div className="row">
            <label>ID <input value={id} onChange={e => setId(e.target.value)} /></label>
            <label>Name <input value={name} onChange={e => setName(e.target.value)} /></label>
            <label>Enroll code <input value={code} onChange={e => setCode(e.target.value)} placeholder="CISO-2025" /></label>
          </div>
          <div className="row mt">
            <label>Meeting ID <input value={meetingId} onChange={e => setMeetingId(e.target.value)} /></label>
            <label>Zoom Email <input value={zoomEmail} onChange={e => setZoomEmail(e.target.value)} /></label>
            <label>Participant UUID (optional) <input value={participantUUID} onChange={e => setParticipantUUID(e.target.value)} placeholder="paste from ZoomBridge" /></label>
          </div>
          <div className="row mt">
            <button className="btn" onClick={connectWS}>Connect WS</button>
            <button className="btn" onClick={closeWS}>Disconnect</button>
            <button className="btn" onClick={checkService}>Service Health</button>
            <button className="btn primary" onClick={enroll}>Enroll (SSO → TPM pubkey)</button>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            In production, Companion generates a non-exportable key in TPM/Secure Enclave and enrolls it via SSO. This demo uses a local signer and a demo SSO token.
          </div>
        </div>

        <div className="card mt">
          <h3>Log</h3>
          <pre className="log">{log.join('\n')}</pre>
        </div>
      </main>
    </div>
  );
}