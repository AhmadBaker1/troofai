// Companion.jsx
import React, { useRef, useState } from 'react';

const HEADLESS = true;
const HUB_URL = import.meta.env.VITE_HUB_URL || 'ws://127.0.0.1:8080';
const SERVICE_URL = import.meta.env.VITE_SERVICE_URL || 'http://127.0.0.1:8787';

export default function Companion() {
  const [wsState, setWsState] = useState('Disconnected');

  const [id, setId] = useState('ciso');
  const [name, setName] = useState('CISO (Maya)');
  const [code, setCode] = useState('CISO-2025');
  const [meetingId, setMeetingId] = useState('mtg-123');
  const [zoomDisplayName, setZoomDisplayName] = useState('TroofAIDemo');

  const [log, setLog] = useState([]);
  const wsRef = useRef(null);
  const stateRef = useRef({
    pending: null,
    pubPem: null,
    retry: 0,
    closed: false,
  });

  function push(msg) {
    setLog(x => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...x].slice(0, 300));
  }

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

      ws.send(JSON.stringify({
        type: 'role',
        role: 'sender',
        participantId: id,
        displayName: name,
        enrollCode: code || null,
        meetingId,
        zoomDisplayName
      }));

      registerPubKey();
    };

    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'meeting_context' && msg.meetingId) {
        push('Meeting context updated from Zoom: ' + msg.meetingId);
        setMeetingId(String(msg.meetingId));
    }
      if (msg.type === 'verify_now' && msg.participantId === id) {
        const v = msg.payload;
        push(`VERIFY n=${v.n} pat=${v.pattern} mtg=${v.meetingId}`);
        stateRef.current.pending = {
          meetingId: v.meetingId,
          pattern: v.pattern,
          n: v.n,
          ts: v.ts,
          challengeId: v.challengeId || ''
        };
        if (HEADLESS) sendSidecarOnce();
      }
    };

    ws.onerror = () => { try { ws.close(); } catch {}; };
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

    // Get device state quote
    let quote = '';
    try {
      const qr = await fetch(`${SERVICE_URL}/quote`);
      const qj = await qr.json();
      quote = qj.quote || '';
    } catch {}

    const canonical = `${mtg}|${id}|${p.challengeId}|${p.n}|${p.ts}|${p.pattern}|${quote}`;

    try {
      const resp = await fetch(`${SERVICE_URL}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canonical })
      });
      if (!resp.ok) throw new Error(`sign HTTP ${resp.status}`);
      const { sigHex } = await resp.json();

      wsRef.current?.send(JSON.stringify({
        type: 'sidecar',
        participantId: id,
        payload: {
          meetingId: mtg,
          n: p.n,
          ts: p.ts,
          pattern: p.pattern,
          challengeId: p.challengeId,
          quote,
          sigHex,
          alg: 'ECDSA-P256-DER'
        }
      }));
      push(`Sidecar sent n=${p.n}`);
    } catch (e) {
      push('Sign error: ' + e.message);
    } finally {
      stateRef.current.pending = null;
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
            <label>Zoom Display Name <input value={zoomDisplayName} onChange={e => setZoomDisplayName(e.target.value)} /></label>
          </div>
          <div className="row mt">
            <button className="btn" onClick={connectWS}>Connect WS</button>
            <button className="btn" onClick={closeWS}>Disconnect</button>
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