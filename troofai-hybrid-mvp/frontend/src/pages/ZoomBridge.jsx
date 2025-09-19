// frontend/src/pages/ZoomBridge.jsx
import React, { useRef, useState, useEffect } from 'react';
import { ZoomMtg } from '@zoom/meetingsdk';

const HUB_URL  = import.meta.env.VITE_HUB_URL || 'ws://127.0.0.1:8080';
const AUTH_URL = import.meta.env.VITE_ZOOM_AUTH_URL || 'http://127.0.0.1:8888/zoom-auth';
const ZSDK_KEY = import.meta.env.VITE_ZOOM_SDK_KEY || '';

export default function ZoomBridge() {
  const [status, setStatus] = useState('idle');
  const [meetingNumber, setMN] = useState(import.meta.env.VITE_ZOOM_MEETING_NUMBER || '');
  const [passcode, setPW] = useState(import.meta.env.VITE_ZOOM_PASSCODE || '');
  const [userName, setName] = useState('TroofAI Demo');

  const wsRef = useRef(null);
  const currentUsersRef = useRef(new Map()); // key -> displayName (key = userId/UUID/name fallback)

  useEffect(() => {
    const end = () => {
      wsRef.current?.send(JSON.stringify({
        type: 'reset_meeting',
        meetingId: String(meetingNumber || 'mtg-unknown')
      }));
    };
    window.addEventListener('beforeunload', end);
    return () => window.removeEventListener('beforeunload', end);
  }, [meetingNumber]);

  function ensureHub() {
    if (wsRef.current && wsRef.current.readyState === 1) return;
    const ws = new WebSocket(HUB_URL);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type:'role', role:'verifier' }));
      // broadcast the meeting context as soon as we know the meeting number
      if (meetingNumber) {
        ws.send(JSON.stringify({ type:'meeting_context', meetingId: String(meetingNumber) }));
      }
    };
    wsRef.current = ws;
  }

  // Send a FULL snapshot of the roster; hub will mark non-seen names as present:false
  function pushRosterSnapshot() {
    const roster = [...currentUsersRef.current.values()].map(displayName => ({ displayName }));
    wsRef.current?.send(JSON.stringify({
      type: 'set_meeting',
      meetingId: String(meetingNumber || 'mtg-unknown'),
      roster,
      pruneMissing: true
    }));
  }

  // Utility to add/remove users in our snapshot map
  function upsertUsers(list) {
    for (const u of list) {
      const displayName = u.userName || 'Participant';
      const key = String(u.userId ?? u.participantUUID ?? displayName);
      currentUsersRef.current.set(key, displayName);
    }
  }
  function removeUsers(list) {
    for (const u of list) {
      const displayName = u.userName || 'Participant';
      const key = String(u.userId ?? u.participantUUID ?? displayName);
      currentUsersRef.current.delete(key);
    }
  }

  async function joinZoom() {
    if (!ZSDK_KEY) { alert('Missing VITE_ZOOM_SDK_KEY'); return; }
    if (!meetingNumber) { alert('Set Zoom meeting number'); return; }

    ensureHub();

    setStatus('preparing');
    ZoomMtg.setZoomJSLib('https://source.zoom.us/4.0.7/lib', '/av');
    ZoomMtg.preLoadWasm();
    ZoomMtg.prepareWebSDK();
    ZoomMtg.i18n.load('en-US');
    ZoomMtg.i18n.reload('en-US');

    // Auth server creates an SDK signature
    const signature = await fetch(`${AUTH_URL}?mn=${encodeURIComponent(meetingNumber)}&role=0`).then(r => r.text());

    setStatus('joining');
    ZoomMtg.init({
      leaveUrl: window.location.origin,
      success: () => {
        // Tell the hub the meeting context again (now that we’re really joining)
        wsRef.current?.send(JSON.stringify({ type:'meeting_context', meetingId: String(meetingNumber) }));

        ZoomMtg.join({
          signature,
          sdkKey: ZSDK_KEY,
          meetingNumber,
          userName,
          passWord: passcode,
          success: () => {
            setStatus('joined');

            // On self-join, include ourselves immediately so Companion can bind
            currentUsersRef.current.set(`self-${Date.now()}`, userName);
            pushRosterSnapshot();

            // JOIN listener → add users, send full snapshot
            ZoomMtg.inMeetingServiceListener('onUserJoin', (payload) => {
              const items = (payload.userList && Array.isArray(payload.userList)) ? payload.userList : [payload];
              upsertUsers(items);
              pushRosterSnapshot();
            });

            // LEAVE listener → remove users, send full snapshot (hub marks them present:false)
            ZoomMtg.inMeetingServiceListener('onUserLeave', (payload) => {
              const items = (payload.userList && Array.isArray(payload.userList)) ? payload.userList : [payload];
              removeUsers(items);
              pushRosterSnapshot();
            });
          },
          error: (err) => { console.error('Zoom join error', err); setStatus('error'); }
        });
      },
      error: (err) => { console.error('Zoom init error', err); setStatus('error'); }
    });
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="dot" /> TroofAI • Zoom Bridge</div>
        <div className="ws">{status}</div>
      </header>

      <main className="content">
        <div className="card">
          <div className="row">
            <label>Zoom Meeting # <input value={meetingNumber} onChange={e=>setMN(e.target.value)} placeholder="1234567890" /></label>
            <label>Passcode <input value={passcode} onChange={e=>setPW(e.target.value)} placeholder="passcode" /></label>
          </div>
          <div className="row mt">
            <label>Your Display Name <input value={userName} onChange={e=>setName(e.target.value)} /></label>
          </div>
          <div className="row mt">
            <button className="btn primary" onClick={joinZoom}>Join Zoom & Bridge</button>
          </div>
          <div className="small muted mt">
            We mirror the live roster by sending <b>full snapshots</b> on every join/leave.  
            Emails aren’t exposed on Basic plans, so we bind by <b>display name</b> for the demo.
          </div>
        </div>

        {/* Zoom injects UI here */}
        <div id="zmmtg-root"></div>
      </main>
    </div>
  );
}