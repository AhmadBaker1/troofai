import React, { useEffect, useRef, useState } from 'react';

// ===== Robust DER ECDSA -> raw r|s (64B) for P-256 =====
function derToRaw(derHex) {
  const b = Uint8Array.from(derHex.match(/.{1,2}/g).map(h => parseInt(h, 16)));
  let i = 0;
  const expect = (val) => { if (b[i++] !== val) throw new Error('Bad DER structure'); };
  const readLen = () => {
    let len = b[i++];
    if (len < 0x80) return len;
    const n = len & 0x7f;
    if (n === 0 || n > 2) throw new Error('Unsupported DER length');
    let out = 0;
    for (let k = 0; k < n; k++) out = (out << 8) | b[i++];
    return out;
  };
  expect(0x30);
  const seqLen = readLen();
  const seqEnd = i + seqLen;
  expect(0x02);
  const rLen = readLen();
  let r = b.slice(i, i + rLen); i += rLen;
  expect(0x02);
  const sLen = readLen();
  let s = b.slice(i, i + sLen); i += sLen;
  if (i !== seqEnd) throw new Error('Trailing DER bytes');
  while (r.length > 0 && r[0] === 0x00) r = r.slice(1);
  while (s.length > 0 && s[0] === 0x00) s = s.slice(1);
  if (r.length > 32 || s.length > 32) throw new Error('Curve size mismatch after trim');
  const to32 = (x) => { const out = new Uint8Array(32); out.set(x, 32 - x.length); return out; };
  const raw = new Uint8Array(64);
  raw.set(to32(r), 0);
  raw.set(to32(s), 32);
  return raw.buffer;
}

// ===== Tunables =====
const DETECT_WINDOW_MS = 1400;         // manual/auto verify timeout window
const AUTO_VERIFY_DELAY_MS = 250;      // debounce for auto-verify
const PER_PERSON_THROTTLE_MS = 2000;   // avoid spamming same person (except on join)

export default function Admin() {
  const [wsState, setWsState] = useState('Disconnected');
  const [participants, setParticipants] = useState(new Map());
  const participantsRef = useRef(new Map());

  const [meetingId, setMeetingId] = useState('mtg-123');
  const meetingIdRef = useRef(meetingId);
  useEffect(() => { meetingIdRef.current = meetingId; }, [meetingId]);

  // Manual roster textarea (kept for non-Zoom demos)
  const [rosterText, setRosterText] = useState('maya.ciso@company.com\nimp@random.tld');

  // Zoom-first UX: hide/ignore manual roster when this is true
  const [zoomPresenceMode, setZoomPresenceMode] = useState(true);

  // meetingRoster: union of Zoom Bridge presence + (optional) manual roster
  // key -> { zoomEmail?, participantUUID?, displayName, participantId? }
  const [meetingRoster, setMeetingRoster] = useState(new Map());

  const [events, setEvents] = useState([]);
  const wsRef = useRef(null);

  // ===== Auto-verify state/helpers =====
  const [autoVerifyOnJoin, setAutoVerifyOnJoin] = useState(true);
  const lastAutoRef = useRef(new Map());   // pid -> last timestamp
  const autoTimersRef = useRef(new Map()); // pid -> setTimeout id

  const logEvent = (e) => setEvents(prev => [e, ...prev].slice(0, 200));

  // Status chip helpers
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
          enrolled: !!info.enrolled,
          hasKey: !!info.hasKey,
          pending: null,
          pubKey: null,
          statusText: info.hasKey ? 'Enrolled' : 'Unverified',
          statusLevel: info.hasKey ? 'neutral' : 'warn',
          trustEma: 60,
          __queuedSidecar: null,
          goldenBaseline: null,
        };
      } else {
        p.displayName = info.displayName || p.displayName;
        p.enrolled = !!info.enrolled;
        p.hasKey = !!info.hasKey;
      }
      curr.set(info.id, p);
      participantsRef.current = curr;
      return curr;
    });
  }

  // ===== Auto-verify scheduler (challenges EVERYONE; re-challenges on rejoin) =====
  function scheduleAutoVerify(pid, reason = 'presence') {
    if (!autoVerifyOnJoin) return;
    const p = participantsRef.current.get(pid);
    if (!p) return; // must at least know participant

    const now = Date.now();
    const last = lastAutoRef.current.get(pid) || 0;

    // On explicit "join", bypass throttle so rejoin triggers immediately.
    const bypassThrottle = (reason === 'join');
    if (!bypassThrottle && now - last < PER_PERSON_THROTTLE_MS) return;

    // debounce: clear pending timer then schedule
    const t = autoTimersRef.current.get(pid);
    if (t) clearTimeout(t);

    const tid = setTimeout(() => {
      lastAutoRef.current.set(pid, Date.now());
      sendVerify(pid);
      logEvent({ t: Date.now(), kind: 'auto_verify', participantId: pid, reason });
    }, AUTO_VERIFY_DELAY_MS);
    autoTimersRef.current.set(pid, tid);
  }

  // ===== Admin controls =====
  const pushRoster = () => {
    // If in Zoom presence mode, ignore manual roster
    if (zoomPresenceMode) return;

    const list = rosterText.split(/\r?\n/)
      .map(x => x.trim()).filter(Boolean)
      .map(e => ({ zoomEmail: e, displayName: e }));

    wsRef.current?.send(JSON.stringify({ type:'set_meeting', meetingId, roster:list }));
  };

  // Verify (works for key/no-key; timeout marks Unverified (no key))
  function sendVerify(participantId) {
    const ws = wsRef.current; if (!ws || ws.readyState !== 1) return;

    const existing = participantsRef.current.get(participantId);
    const p = existing || { id: participantId, hasKey: false, statusText:'', statusLevel:'warn' };

    setStatus(p, 'Challenged', 'neutral');
    logEvent({ t: Date.now(), kind:'challenge_issued', participantId, meetingId: meetingIdRef.current });

    const token = crypto.getRandomValues(new Uint32Array(1))[0];
    if (existing) {
      existing.pending = { token, startAt: performance.now() };
      setParticipants(prev => new Map(prev));
    }

    ws.send(JSON.stringify({
      type: 'verify_now',
      by: 'participantId',
      meetingId: meetingIdRef.current,
      participantId
    }));

    setTimeout(() => {
      const q = participantsRef.current.get(participantId);
      if (q?.pending && q.pending.token === token) {
        const label  = q?.hasKey ? 'Untrusted (timeout)' : 'Unverified (no key)';
        setStatus(q, label, 'bad');
        q.pending = null;
        setParticipants(prev => new Map(prev));
        logEvent({ t: Date.now(), kind:'verification', participantId, meetingId: meetingIdRef.current, result:'untrusted', reason: q?.hasKey ? 'timeout' : 'no_key' });
      }
    }, DETECT_WINDOW_MS + 300);
  }

  // Blind challenges (email / UUID) for Zoom attendees not yet bound to a sender
  function verifyByEmail(zoomEmail) {
    const ws = wsRef.current; if (!ws || ws.readyState !== 1) return;

    const blindId = `email:${(zoomEmail||'').toLowerCase()}`;
    const token = crypto.getRandomValues(new Uint32Array(1))[0];

    setParticipants(prev => {
      const curr = new Map(prev);
      const ghost = curr.get(blindId) || { id: blindId, hasKey:false, statusText:'', statusLevel:'warn' };
      ghost.pending = { token, startAt: performance.now(), blind: true };
      curr.set(blindId, ghost);
      participantsRef.current = curr;
      return curr;
    });
    const ghost = participantsRef.current.get(blindId);
    setStatus(ghost, 'Challenged', 'neutral');

    ws.send(JSON.stringify({
      type: 'verify_now',
      by: 'zoomEmail',
      meetingId: meetingIdRef.current,
      zoomEmail
    }));

    setTimeout(() => {
      const q = participantsRef.current.get(blindId);
      if (q?.pending && q.pending.token === token) {
        setStatus(q, 'Unverified (no key)', 'bad');
        q.pending = null;
        setParticipants(prev => new Map(prev));
      }
    }, DETECT_WINDOW_MS + 300);
  }

  function verifyByUUID(participantUUID) {
    const ws = wsRef.current; if (!ws || ws.readyState !== 1) return;

    const blindId = `uuid:${participantUUID}`;
    const token = crypto.getRandomValues(new Uint32Array(1))[0];

    setParticipants(prev => {
      const curr = new Map(prev);
      const ghost = curr.get(blindId) || { id: blindId, hasKey:false, statusText:'', statusLevel:'warn' };
      ghost.pending = { token, startAt: performance.now(), blind: true };
      curr.set(blindId, ghost);
      participantsRef.current = curr;
      return curr;
    });
    const ghost = participantsRef.current.get(blindId);
    setStatus(ghost, 'Challenged', 'neutral');

    ws.send(JSON.stringify({
      type: 'verify_now',
      by: 'participantUUID',
      meetingId: meetingIdRef.current,
      participantUUID
    }));

    setTimeout(() => {
      const q = participantsRef.current.get(blindId);
      if (q?.pending && q.pending.token === token) {
        setStatus(q, 'Unverified (no key)', 'bad');
        q.pending = null;
        setParticipants(prev => new Map(prev));
      }
    }, DETECT_WINDOW_MS + 300);
  }

  // ===== Sidecar verification =====
  async function consumeSidecar(p, sc) {
    if (!p.pubKey) { p.__queuedSidecar = sc; return; }

    const expired = (typeof sc.issuedAt === 'number' && typeof sc.ttlMs === 'number')
      ? (Date.now() > sc.issuedAt + sc.ttlMs)
      : false;

    // meetingId|participantId|challengeId|n|issuedAt|pattern|golden
    const canonical = [
      sc.meetingId || '',
      p.id,
      sc.challengeId || '',
      sc.n || '',
      String(sc.issuedAt || ''),
      sc.pattern || '',
      sc.golden || ''
    ].join('|');

    let ok = false;
    let reason = 'bad_sig';
    try {
      ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        p.pubKey,
        derToRaw(sc.sigHex),
        new TextEncoder().encode(canonical)
      );
      if (ok && expired) { ok = false; reason = 'expired'; }
      else if (ok) reason = 'ok';
    } catch (e) {
      console.error('[Admin] verify error', e);
      ok = false; reason = 'verify_error';
    }

    if (ok) {
      if (!p.goldenBaseline && sc.golden) p.goldenBaseline = sc.golden;
      const drift = p.goldenBaseline && sc.golden && p.goldenBaseline !== sc.golden;
      const label = sc.keyId
        ? (drift ? `Trusted (key ${sc.keyId.slice(0,6)}, state CHANGED)` : `Trusted (key ${sc.keyId.slice(0,6)})`)
        : (drift ? 'Trusted (state CHANGED)' : 'Trusted (sig ok)');

      setStatus(p, label, drift ? 'warn' : 'ok');
      bumpRisk(p, true);
    } else {
      const label = reason === 'expired' ? 'Untrusted (expired)' : 'Untrusted (bad sig)';
      setStatus(p, label, 'bad'); bumpRisk(p, false);
    }

    wsRef.current?.send(JSON.stringify({
      type: 'verification_result',
      participantId: p.id,
      meetingId: sc.meetingId,
      result: ok ? 'trusted' : 'untrusted',
      reason,
      at: Date.now()
    }));

    logEvent({
      t: Date.now(),
      kind: 'verification',
      participantId: p.id,
      meetingId: sc.meetingId,
      result: ok ? 'trusted' : 'untrusted',
      reason,
      keyId: sc.keyId || null,
      golden: sc.golden || null,
      challengeId: sc.challengeId
    });

    p.pending = null;
    p.__queuedSidecar = null;
  }

  // ===== Key import =====
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
          p.pubKey = key; p.hasKey = true;
          p.statusText = 'Enrolled'; p.statusLevel = 'neutral';
          if (p.__queuedSidecar) consumeSidecar(p, p.__queuedSidecar);
          curr.set(participantId, p);
        }
        participantsRef.current = curr;
        return curr;
      });
      console.log('[Admin] Imported pubkey for', participantId);
    } catch (e) {
      console.error('Key import failed', e);
    }
  }

  // ===== WebSocket wiring =====
  useEffect(() => {
    const ws = new WebSocket(import.meta.env.VITE_HUB_URL || 'ws://127.0.0.1:8080'); wsRef.current = ws;
    ws.onopen = () => {
      setWsState('Connected');
      if (import.meta.env.VITE_HUB_TOKEN) {
        ws.send(JSON.stringify({ type:'auth', token: import.meta.env.VITE_HUB_TOKEN }));
      }
      ws.send(JSON.stringify({ type:'role', role:'verifier' }));
      ws.send(JSON.stringify({ type:'participants_request' }));
    };
    ws.onclose = () => setWsState('Disconnected');
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'participants') for (const info of msg.list) ensureParticipant(info);

      if (msg.type === 'participant_join') {
        ensureParticipant(msg.info);
        scheduleAutoVerify(msg.info.id, 'join'); // re-challenge on join
        logEvent({ t:Date.now(), kind:'join', participantId: msg.info.id });
      }

      if (msg.type === 'participant_leave') {
        lastAutoRef.current.delete(msg.participantId);
        setParticipants(prev => { const curr=new Map(prev); curr.delete(msg.participantId); participantsRef.current=curr; return curr; });
        logEvent({ t:Date.now(), kind:'leave', participantId: msg.participantId });
      }

      if (msg.type === 'pubkey_pem') {
        importPemSpki(msg.participantId, msg.pem);
        scheduleAutoVerify(msg.participantId, 'key_arrived');
      }

      if (msg.type === 'pubkey_clear') {
        setParticipants(prev => {
          const curr = new Map(prev); const p = curr.get(msg.participantId);
          if (p) { p.pubKey=null; p.hasKey=false; p.statusText='Unverified'; p.statusLevel='warn'; }
          participantsRef.current = curr; return curr;
        });
      }

      if (msg.type === 'meeting_roster') {
        // When Zoom presence mode is ON, roster is fed by Zoom Bridge.
        const m = new Map();
        for (const r of msg.roster) {
          const email = (r.zoomEmail || null);
          const uuid  = (r.participantUUID || null);
          const key = email || uuid || Math.random().toString(16).slice(2);
          m.set(key, { zoomEmail: email, participantUUID: uuid, displayName: r.displayName || email || uuid || '', participantId: r.participantId || null });
        }
        setMeetingRoster(m);
      }

      if (msg.type === 'meeting_presence') {
        setMeetingRoster(prev => {
          const np = new Map(prev);
          let matchedKey = null;
          for (const [k, v] of np.entries()) {
            const emailMatch = v.zoomEmail && msg.zoomEmail && v.zoomEmail.toLowerCase() === msg.zoomEmail.toLowerCase();
            const uuidMatch  = v.participantUUID && msg.participantUUID && v.participantUUID === msg.participantUUID;
            if (emailMatch || uuidMatch) { matchedKey = k; break; }
          }
          if (matchedKey) {
            const entry = np.get(matchedKey) || {};
            entry.participantId = msg.participantId;
            if (msg.participantUUID) entry.participantUUID = msg.participantUUID;
            np.set(matchedKey, entry);
          } else {
            const key = (msg.zoomEmail || msg.participantUUID || Math.random().toString(16).slice(2));
            np.set(key, { zoomEmail: msg.zoomEmail || null, participantUUID: msg.participantUUID || null, displayName: msg.zoomEmail || msg.participantUUID || '', participantId: msg.participantId });
          }
          return np;
        });
        if (msg.participantId) scheduleAutoVerify(msg.participantId, 'presence');
      }

      if (msg.type === 'rate_limited') {
        logEvent({ t:Date.now(), kind:'rate_limited', participantId: msg.participantId, meetingId: msg.meetingId });
      }

      if (msg.type === 'challenge_violation') {
        const p = participantsRef.current.get(msg.participantId);
        if (p) { setStatus(p, `Untrusted (${msg.reason})`, 'bad'); bumpRisk(p, false); }
        logEvent({ t:Date.now(), kind:'challenge_violation', participantId: msg.participantId, reason: msg.reason });
      }

      if (msg.type === 'sidecar') {
        const p = participantsRef.current.get(msg.participantId);
        if (!p) { console.warn('[Admin] sidecar for unknown participant', msg.participantId); return; }
        const sc = msg.payload;
        consumeSidecar(p, sc);
      }

      if (msg.type === 'verification_result') {
        logEvent({ t:Date.now(), kind:'verification_result', ...msg });
      }
    };

    return () => ws.close();
  }, []);

  // ===== Derived roster items for UI =====
  const rosterItems = [...meetingRoster.values()].map(r => {
    const pid = r.participantId; const p = pid ? participants.get(pid) : null;
    const statusText = p?.statusText || (p?.hasKey ? 'Enrolled' : (pid ? 'Present (no key)' : 'Not present'));
    const statusLevel = p?.statusLevel || (p?.hasKey ? 'neutral' : (pid ? 'warn' : 'warn'));
    return {
      email: r.zoomEmail || null,
      uuid: r.participantUUID || null,
      displayName: r.displayName || r.zoomEmail || r.participantUUID || 'Unknown',
      pid, p, statusText, statusLevel
    };
  });

  const initials = (s='') => s.split(/\s+|@/)[0].slice(0,1).toUpperCase();

  const verifyAll = () => {
    rosterItems.forEach(item => {
      if (item.pid) sendVerify(item.pid);
      else if (item.uuid) verifyByUUID(item.uuid);
      else if (item.email) verifyByEmail(item.email);
    });
  };

  const fmtTime = (t) => new Date(t).toLocaleTimeString();

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="dot" /> TroofAI Admin</div>
        <div className="ws">WS: {wsState}</div>
      </header>

      <main className="content">
        {/* Controls */}
        <div className="card">
          <div className="row" style={{gap:12, alignItems:'center', flexWrap:'wrap'}}>
            <label style={{minWidth:280}}>
              Meeting ID
              <input value={meetingId} onChange={e => setMeetingId(e.target.value)} placeholder="mtg-123" />
            </label>

            <button className="btn primary" onClick={pushRoster} disabled={zoomPresenceMode}>
              Set Roster
            </button>

            <button className="btn" onClick={verifyAll}>Verify All</button>

            <label className="row" style={{alignItems:'center', gap:8}}>
              <input type="checkbox" checked={autoVerifyOnJoin} onChange={e => setAutoVerifyOnJoin(e.target.checked)} />
              Auto-verify on join (key & no-key)
            </label>

            <label className="row" style={{alignItems:'center', gap:8}}>
              <input type="checkbox" checked={zoomPresenceMode} onChange={e => setZoomPresenceMode(e.target.checked)} />
              Zoom presence mode (ignore manual roster)
            </label>
          </div>

          {/* Manual roster textarea only when not in Zoom presence mode */}
          {!zoomPresenceMode && (
            <>
              <textarea rows={4} className="mt" style={{width:'100%'}}
                value={rosterText} onChange={e => setRosterText(e.target.value)}
                placeholder="Paste emails, one per line" />
              <div className="small muted mt">Manual roster. Zoom Bridge overrides this when enabled.</div>
            </>
          )}
        </div>

        {/* Summary strip */}
        <div className="stats mt">
          <div className="stat">
            <div className="small muted">Verified</div>
            <div className="value">{[...participants.values()].filter(x => x.statusLevel === 'ok').length}</div>
          </div>
          <div className="stat">
            <div className="small muted">Unverified</div>
            <div className="value">{[...participants.values()].filter(x => x.statusLevel !== 'ok').length}</div>
          </div>
          <div className="stat">
            <div className="small muted">Participants</div>
            <div className="value">{participants.size}</div>
          </div>
        </div>

        {/* Roster as cards */}
        <div className="card mt">
          <h3>People in this meeting</h3>
          <div className="cards mt">
            {rosterItems.length === 0 && <div className="muted">Waiting for participants… Join a meeting via the Zoom Bridge.</div>}
            {rosterItems.map(item => (
              <div key={(item.email || item.uuid || Math.random().toString(16)).toString()} className="person">
                <div className="ava">{initials(item.displayName || item.email || item.uuid)}</div>
                <div className="pmeta">
                  <div className="ptitle">{item.displayName}</div>
                  <div className="psub">
                    {item.email || '—'}
                    {item.uuid && <span className="muted"> • UUID {item.uuid.slice(0,8)}…</span>}
                  </div>
                  <div className="row" style={{marginTop:10}}>
                    <span className={`chip ${item.statusLevel}`} id={item.pid ? `status-${item.pid}` : undefined}>
                      {item.pid ? (participants.get(item.pid)?.statusText || item.statusText) : item.statusText}
                    </span>
                    {item.p?.hasKey && <span className="chip neutral">Key present</span>}
                    {!item.pid && <span className="chip warn">Not bound yet</span>}
                  </div>
                </div>
                <div className="actions">
                  <button
                    className="btn primary"
                    onClick={() => item.pid ? sendVerify(item.pid) : (item.uuid ? verifyByUUID(item.uuid) : verifyByEmail(item.email))}
                    disabled={false}
                    title={item.pid && !item.p?.hasKey ? 'User not enrolled' : 'Send challenge'}
                  >
                    Verify
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Events / Audit Pane */}
        <div className="card mt">
          <h3>Events</h3>
          <div className="events">
            {events.map((e, i) => (
              <div key={i} className="ev">
                <span className="ts">{fmtTime(e.t)}</span>
                <span className="k">{e.kind}</span>
                {'participantId' in e && <span className="v">{e.participantId}</span>}
                {'meetingId' in e && <span className="v">mtg={e.meetingId}</span>}
                {'reason' in e && <span className="v">reason={e.reason}</span>}
                {'result' in e && <span className="v">{e.result}</span>}
                {'keyId' in e && e.keyId && <span className="v">key={e.keyId.slice(0,6)}</span>}
                {'challengeId' in e && e.challengeId && <span className="v">chal={e.challengeId.slice(0,6)}</span>}
              </div>
            ))}
          </div>
        </div>

      </main>
    </div>
  );
}