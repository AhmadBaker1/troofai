import React, { useEffect, useRef, useState } from 'react';

const DETECT_WINDOW_MS = 1400;
const AUTO_VERIFY_DELAY_MS = 250;

// DER ECDSA → raw r||s (P-256)
function derToRaw(derHex) {
  const b = Uint8Array.from(derHex.match(/.{1,2}/g).map(h => parseInt(h, 16)));
  let i = 0; if (b[i++] !== 0x30) throw new Error('Bad DER');
  let len = b[i++]; if (len & 0x80) i += (len & 0x7f);
  if (b[i++] !== 0x02) throw new Error('Bad r');
  let rLen = b[i++]; let r = b.slice(i, i + rLen); i += rLen;
  if (b[i++] !== 0x02) throw new Error('Bad s');
  let sLen = b[i++]; let s = b.slice(i, i + sLen);
  const to32 = (x) => { while (x.length && x[0] === 0) x = x.slice(1); const out = new Uint8Array(32); out.set(x, 32 - x.length); return out; };
  const raw = new Uint8Array(64); raw.set(to32(r), 0); raw.set(to32(s), 32); return raw.buffer;
}

export default function Admin() {
  const [wsState, setWsState] = useState('Disconnected');
  const [participants, setParticipants] = useState(new Map()); // pid -> participant
  const participantsRef = useRef(new Map());

  const [meetingId, setMeetingId] = useState('mtg-123');
  const meetingIdRef = useRef(meetingId);
  useEffect(()=>{ meetingIdRef.current = meetingId; }, [meetingId]);

  // displayName (lower) -> { displayName, participantId? }
  const [meetingRoster, setMeetingRoster] = useState(new Map());
  const wsRef = useRef(null);

  const [autoVerifyOnJoin, setAutoVerifyOnJoin] = useState(true);
  const lastAutoRef = useRef(new Map());
  const autoTimersRef = useRef(new Map());

  const randNonce = (len=3) => [...crypto.getRandomValues(new Uint8Array(len))].map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();

  function scheduleAutoVerifyByPid(pid) {
    if (!autoVerifyOnJoin) return;
    const p = participantsRef.current.get(pid);
    if (!p) return;
    const now = Date.now();
    const last = lastAutoRef.current.get(pid) || 0;
    if (now - last < 2000) return;
    const t = autoTimersRef.current.get(pid); if (t) clearTimeout(t);
    const tid = setTimeout(() => {
      lastAutoRef.current.set(pid, Date.now());
      sendVerify(pid);
    }, AUTO_VERIFY_DELAY_MS);
    autoTimersRef.current.set(pid, tid);
  }

  const setStatus = (p, text, level) => {
    p.statusText = text; p.statusLevel = level;
    const el = document.getElementById(`status-${p.id}`);
    if (el) { el.textContent = text; el.className = `chip ${level}`; }
    setParticipants(prev => new Map(prev));
  };
  const bumpRisk = (p, ok) => {
    p.trustEma = 0.88 * (p.trustEma ?? 60) + 0.12 * (ok ? 100 : 0);
    setParticipants(prev => new Map(prev));
  };

  function ensureParticipant(info) {
    setParticipants(prev => {
      const curr = new Map(prev);
      let p = curr.get(info.id);
      if (!p) {
        p = {
          id: info.id,
          displayName: info.displayName || info.id,
          hasKey: !!info.hasKey,
          pending: null, pubKey: null,
          statusText: info.hasKey ? 'Enrolled' : 'Unverified',
          statusLevel: info.hasKey ? 'neutral' : 'warn',
          trustEma: 60
        };
      } else {
        p.displayName = info.displayName || p.displayName;
        p.hasKey = !!info.hasKey;
      }
      curr.set(info.id, p);
      participantsRef.current = curr;
      return curr;
    });
  }

  function sendVerify(participantId) {
    const ws = wsRef.current; if (!ws || ws.readyState !== 1) return;
    const p = participantsRef.current.get(participantId); if (!p) return;

    const pattern = Math.random() < 0.5 ? 'A' : 'B';
    const n = randNonce(3), ts = Date.now();
    p.pending = { pattern, n, startAt: performance.now(), expiresAt: performance.now() + DETECT_WINDOW_MS };
    setStatus(p, `Challenged (${pattern})`, 'neutral');

    ws.send(JSON.stringify({
      type: 'verify_now',
      by: 'participantId',
      meetingId: meetingIdRef.current,
      participantId,
      payload: { n, ts, pattern, meetingId: meetingIdRef.current }
    }));

    setTimeout(() => {
      const q = participantsRef.current.get(participantId);
      if (q?.pending && q.pending.n === n) {
        setStatus(q, 'Unverified (timeout)', 'bad'); bumpRisk(q, false); q.pending = null;
      }
    }, DETECT_WINDOW_MS + 250);
  }

  function verifyByDisplayName(displayName) {
    const ws = wsRef.current; if (!ws || ws.readyState !== 1) return;
    const pattern = Math.random() < 0.5 ? 'A' : 'B';
    const n = randNonce(3), ts = Date.now();

    ws.send(JSON.stringify({
      type: 'verify_now',
      by: 'displayName',
      meetingId: meetingIdRef.current,
      displayName,
      payload: { n, ts, pattern, meetingId: meetingIdRef.current }
    }));
  }

  async function consumeSidecar(p, sc) {
    if (!p.pubKey) { p.__queuedSidecar = sc; return; }

    let timedOut = false;
    if (p.pending) {
      const age = performance.now() - p.pending.startAt;
      timedOut = age > DETECT_WINDOW_MS;
    }

    const canonical = `${sc.meetingId || ''}|${p.id}|${sc.challengeId || ''}|${sc.n}|${sc.ts}|${sc.pattern}`;

    try {
      const ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        p.pubKey,
        derToRaw(sc.sigHex),
        new TextEncoder().encode(canonical)
      );

      if (ok && !timedOut) { setStatus(p, 'Trusted (sig ok)', 'ok'); bumpRisk(p, true); }
      else if (ok && timedOut) { setStatus(p, 'Untrusted (timeout)', 'bad'); bumpRisk(p, false); }
      else { setStatus(p, 'Untrusted (bad sig)', 'bad'); bumpRisk(p, false); }
    } catch {
      setStatus(p, 'Untrusted (verify err)', 'bad'); bumpRisk(p, false);
    }
    p.pending = null;
    p.__queuedSidecar = null;
  }

  async function importPemSpki(participantId, pem) {
    let b64 = pem.replace(/-----BEGIN [^-]+-----/g, '')
                 .replace(/-----END [^-]+-----/g, '')
                 .replace(/\s+/g, '');
    b64 = b64.replace(/-/g, '+').replace(/_/g, '/'); while (b64.length % 4) b64 += '=';
    const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
    try {
      const key = await crypto.subtle.importKey('spki', der, { name:'ECDSA', namedCurve:'P-256' }, false, ['verify']);
      setParticipants(prev => {
        const curr = new Map(prev);
        const p = curr.get(participantId);
        if (p) {
          p.pubKey = key; p.hasKey = true; p.statusText = 'Enrolled'; p.statusLevel = 'neutral';
          if (p.__queuedSidecar) consumeSidecar(p, p.__queuedSidecar);
          curr.set(participantId, p);
        }
        participantsRef.current = curr;
        return curr;
      });
    } catch {}
  }

  // ----- WS -----
  useEffect(() => {
    const ws = new WebSocket(import.meta.env.VITE_HUB_URL || 'ws://127.0.0.1:8080'); wsRef.current = ws;
    ws.onopen = () => {
      setWsState('Connected');
      ws.send(JSON.stringify({ type:'role', role:'verifier' }));
    };
    ws.onclose = () => setWsState('Disconnected');
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'participants') for (const info of msg.list) ensureParticipant(info);
      if (msg.type === 'participant_join') { ensureParticipant(msg.info); scheduleAutoVerifyByPid(msg.info.id); }
      if (msg.type === 'participant_leave') {
        setParticipants(prev => { const curr=new Map(prev); curr.delete(msg.participantId); participantsRef.current=curr; return curr; });
      }
      if (msg.type === 'pubkey_pem') { importPemSpki(msg.participantId, msg.pem); scheduleAutoVerifyByPid(msg.participantId); }
      if (msg.type === 'pubkey_clear') setParticipants(prev => {
        const curr = new Map(prev); const p = curr.get(msg.participantId);
        if (p) { p.pubKey=null; p.hasKey=false; p.statusText='Unverified'; p.statusLevel='warn'; }
        participantsRef.current = curr; return curr;
      });

      if (msg.type === 'meeting_roster') {
        const m = new Map();
        for (const r of msg.roster) {
          const dnLower = (r.displayName || '').toLowerCase();
          m.set(dnLower, { displayName: r.displayName || '' , participantId: r.participantId || null, present: true });
          if (!r.participantId && r.displayName) setTimeout(() => verifyByDisplayName(r.displayName), 200); // blind challenge → Unverified if no key
        }
        setMeetingRoster(m);
      }

      if (msg.type === 'meeting_presence') {
        setMeetingRoster(prev => {
          const np = new Map(prev);
          const key = (msg.displayName||'').toLowerCase();
          const entry = np.get(key) || { displayName:key, present:true };
          entry.participantId = msg.participantId;
          np.set(key, entry);
          return np;
        });
        if (msg.participantId) scheduleAutoVerifyByPid(msg.participantId);
      }

      if (msg.type === 'sidecar') {
        const p = participantsRef.current.get(msg.participantId); if (!p) return;
        consumeSidecar(p, msg.payload);
      }
    };

    return () => ws.close();
  }, []);

  // derived roster cards + counters
  const rosterItems = [...meetingRoster.values()].map(r => {
    const pid = r.participantId; const p = pid ? participants.get(pid) : null;
    const present = true;
    const statusText = p?.statusText || (p?.hasKey ? 'Enrolled' : 'Present (no key)');
    const statusLevel = p?.statusLevel || (p?.hasKey ? 'neutral' : 'warn');
    return { displayName: r.displayName, pid, p, present, statusText, statusLevel };
  });
  const totalPresent    = rosterItems.filter(x => x.present).length;
  const totalTrusted    = rosterItems.filter(x => x.p && x.p.statusLevel === 'ok').length;
  const totalUnverified = rosterItems.filter(x => x.present && (!x.p || x.p.statusLevel !== 'ok')).length;

  function bindNameToPid(displayName, pid) {
    wsRef.current?.send(JSON.stringify({ type:'bind_attendee', meetingId: meetingIdRef.current, displayName, participantId: pid }));
  }

  const initials = (s='') => s.trim().slice(0,1).toUpperCase() || '?';

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="dot" /> TroofAI Admin</div>
        <div className="ws">WS: {wsState}</div>
      </header>

      <main className="content">
        <div className="card">
          <div className="row" style={{alignItems:'center'}}>
            <label style={{minWidth:280}}>
              Meeting ID
              <input value={meetingId} onChange={e => setMeetingId(e.target.value)} placeholder="mtg-123" />
            </label>
            <label className="row" style={{alignItems:'center', gap:8, marginLeft:12}}>
              <input type="checkbox" checked={autoVerifyOnJoin} onChange={e => setAutoVerifyOnJoin(e.target.checked)} />
              Auto-verify on join (key & no-key)
            </label>
          </div>
        </div>

        <div className="stats mt">
          <div className="stat"><div className="small muted">Verified</div><div className="value">{totalTrusted}</div></div>
          <div className="stat"><div className="small muted">Unverified</div><div className="value">{totalUnverified}</div></div>
          <div className="stat"><div className="small muted">Participants</div><div className="value">{totalPresent}</div></div>
        </div>

        <div className="card mt">
          <h3>People in this meeting</h3>
          <div className="cards mt">
            {rosterItems.length === 0 && <div className="muted">No roster yet.</div>}
            {rosterItems.map(item => (
              <div key={item.displayName.toLowerCase()} className="person">
                <div className="ava">{initials(item.displayName)}</div>
                <div className="pmeta">
                  <div className="ptitle">{item.displayName}</div>
                  <div className="row" style={{marginTop:10}}>
                    <span className={`chip ${item.statusLevel}`} id={item.pid ? `status-${item.pid}` : undefined}>
                      {item.pid ? (participants.get(item.pid)?.statusText || item.statusText) : item.statusText}
                    </span>
                    {item.p?.hasKey && <span className="chip neutral">Key present</span>}
                    {!item.pid && <span className="chip warn">Not bound</span>}
                  </div>
                </div>
                <div className="actions">
                  {item.pid
                    ? <button className="btn primary" onClick={() => sendVerify(item.pid)}>Verify</button>
                    : <button className="btn" onClick={() => verifyByDisplayName(item.displayName)}>Verify</button>}
                  {!item.pid && participants.size > 0 && (
                    <select className="btn" onChange={e => bindNameToPid(item.displayName, e.target.value)}>
                      <option>Bind to…</option>
                      {[...participants.values()].map(p => (
                        <option key={p.id} value={p.id}>{p.displayName}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}