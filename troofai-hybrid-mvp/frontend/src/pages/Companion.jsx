import React, { useRef, useState } from 'react';

const HEADLESS = true; // headless: auto-sign on challenge
const HUB_URL = import.meta.env.VITE_HUB_URL || 'ws://127.0.0.1:8080';
const SERVICE_URL = import.meta.env.VITE_SERVICE_URL || 'http://127.0.0.1:8787';
const ENROLL_URL = import.meta.env.VITE_ENROLL_URL || 'http://127.0.0.1:8788/enroll';

export default function Companion() {
  const [wsState, setWsState] = useState('Disconnected');

  // Identity / meeting context
  const [id, setId] = useState('ciso');
  const [name, setName] = useState('CISO (Maya)'); // Zoom display name to bind on
  const [meetingId, setMeetingId] = useState('mtg-123');
  const [corpEmail, setCorpEmail] = useState('maya.ciso@company.com'); // used for enrollment record

  const [log, setLog] = useState([]);
  const wsRef = useRef(null);
  const stateRef = useRef({
    pending: null,   // { meetingId, pattern, n, ts, challengeId }
    pubPem: null,
    retry: 0,
    closed: false,
  });

  function push(msg) { setLog(x => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...x].slice(0, 300)); }

  // --- WS connect with backoff
  function connectWS() { stateRef.current.closed = false; open(); }
  function open() {
    const ws = new WebSocket(HUB_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsState('Connected');
      stateRef.current.retry = 0;
      push('WS connected');

      // announce as sender, include zoomDisplayName for binding without emails
      ws.send(JSON.stringify({
        type: 'role', role: 'sender',
        participantId: id, displayName: name,
        meetingId,
        zoomDisplayName: name
      }));

      // register device public key from local service
      registerPubKey();
    };

    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data) } catch { return; }

      if (msg.type === 'verify_now' && msg.participantId === id) {
        const v = msg.payload;
        push(`VERIFY n=${v.n} pat=${v.pattern} mtg=${v.meetingId}`);
        stateRef.current.pending = { meetingId: v.meetingId, pattern: v.pattern, n: v.n, ts: v.ts, challengeId: v.challengeId };
        if (HEADLESS) sendSidecarOnce();
      }
    };

    ws.onerror = () => { try { ws.close(); } catch {} };
    ws.onclose  = () => {
      setWsState('Disconnected');
      if (stateRef.current.closed) return;
      const delay = Math.min(1000 * (2 ** (stateRef.current.retry++)), 10000);
      push(`WS disconnected — reconnecting in ${Math.round(delay/1000)}s`);
      setTimeout(open, delay);
    };
  }
  function closeWS() { stateRef.current.closed = true; try { wsRef.current?.close(); } catch {} }

  // --- Enrollment (SSO → store TPM pubkey against corp identity)
  async function enrollSSO() {
  try {
    // get pubkey from local signer
    const r = await fetch(`${SERVICE_URL}/pubkey`);
    const j = await r.json();

    const payload = {
      corporateEmail: corpEmail,
      participantId: `acme:${id}`,
      displayName: name,
      pubkeyPem: j.pem
    };

    const headers = { 'Content-Type': 'application/json' };
    // include secret header if present in frontend env (demo)
    if (import.meta.env.VITE_SSO_DEMO_SECRET) {
      headers['x-sso-secret'] = import.meta.env.VITE_SSO_DEMO_SECRET;
    }

    const resp = await fetch(`${ENROLL_URL}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const out = await resp.json();
    if (!resp.ok) throw new Error(`${resp.status} ${out?.error || ''}`.trim());

    push(`Enrolled: participantId=${out.participantId}, keyId=${out.keyId}, deviceId=${out.deviceId || 'n/a'}`);
  } catch (e) {
    push('Enroll error: ' + e.message);
  }
}

  // --- Local device service (TPM/SE mock)
  async function registerPubKey() {
    try {
      const r = await fetch(`${SERVICE_URL}/pubkey`);
      const j = await r.json();
      stateRef.current.pubPem = j.pem;
      push('Got pubkey from local service');
      wsRef.current?.send(JSON.stringify({ type: 'register_pubkey', pem: j.pem }));
    } catch (e) {
      push('Error fetching pubkey: ' + e.message);
    }
  }

  async function sendSidecarOnce() {
    const p = stateRef.current.pending; if (!p) return;
    const mtg = p.meetingId || meetingId;
    const canonical = `${mtg}|${id}|${p.challengeId || ''}|${p.n}|${p.ts}|${p.pattern}`; // headless: no luma / golden

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
        payload: { meetingId: mtg, n: p.n, ts: p.ts, pattern: p.pattern, challengeId: p.challengeId, sigHex, alg: 'ECDSA-P256-DER' }
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
            <label>Name (Zoom display) <input value={name} onChange={e => setName(e.target.value)} /></label>
            <label>Corporate Email <input value={corpEmail} onChange={e => setCorpEmail(e.target.value)} /></label>
          </div>
          <div className="row mt">
            <label>Meeting ID <input value={meetingId} onChange={e => setMeetingId(e.target.value)} /></label>
          </div>
          <div className="row mt">
            <button className="btn" onClick={enrollSSO}>Enroll (SSO → TPM pubkey)</button>
            <button className="btn" onClick={connectWS}>Connect WS</button>
            <button className="btn" onClick={closeWS}>Disconnect</button>
            <button className="btn" onClick={checkService}>Service Health</button>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            Headless mode: device signs challenge immediately (no camera/WebRTC). In production, this runs on a managed device with non-exportable keys.
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