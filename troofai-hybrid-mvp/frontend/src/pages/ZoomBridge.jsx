// frontend/src/pages/ZoomBridge.jsx
import React, { useEffect, useRef, useState } from 'react';
import { ZoomMtg } from '@zoom/meetingsdk'; // Client View (prebuilt UI)

const HUB_URL  = import.meta.env.VITE_HUB_URL || 'ws://127.0.0.1:8080';
const AUTH_URL = import.meta.env.VITE_ZOOM_AUTH_URL || 'http://127.0.0.1:8888/zoom-auth';
const ZSDK_KEY = import.meta.env.VITE_ZOOM_SDK_KEY || '';

export default function ZoomBridge() {
  const [status, setStatus] = useState('idle');
  const [meetingNumber, setMN] = useState(import.meta.env.VITE_ZOOM_MEETING_NUMBER || '');
  const [passcode, setPW] = useState(import.meta.env.VITE_ZOOM_PASSCODE || '');
  const [userName, setName] = useState('TroofAI Demo');
  const [meetingIdForHub, setHubMtg] = useState('mtg-123');

  const hubRef = useRef(null);

  function ensureHub() {
    if (hubRef.current && hubRef.current.readyState === 1) return;
    const ws = new WebSocket(HUB_URL);
    ws.onopen = () => {
      if (import.meta.env.VITE_HUB_TOKEN) {
        ws.send(JSON.stringify({ type:'auth', token: import.meta.env.VITE_HUB_TOKEN }));
      }
      ws.send(JSON.stringify({ type:'role', role:'verifier' })); // lightweight bridge role
    };
    hubRef.current = ws;
  }

  async function joinZoom() {
  if (!ZSDK_KEY) { alert('Missing VITE_ZOOM_SDK_KEY'); return; }
  if (!meetingNumber) { alert('Set Zoom meeting number'); return; }

  ensureHub();

  try {
    setStatus('preparing');
    ZoomMtg.setZoomJSLib('https://source.zoom.us/4.0.7/lib', '/av');
    ZoomMtg.preLoadWasm();
    ZoomMtg.prepareWebSDK(); // v4

    // fetch signature (plain text from your auth server)
    const sigUrl = `${AUTH_URL}?mn=${encodeURIComponent(meetingNumber)}&role=0`;
    const sigResp = await fetch(sigUrl);
    if (!sigResp.ok) throw new Error(`auth ${sigResp.status}`);
    const signature = await sigResp.text();
    if (!signature || signature.length < 20) throw new Error('empty/short signature');

    setStatus('joining');
    ZoomMtg.init({
      leaveUrl: window.location.origin,
      success: () => {
        ZoomMtg.join({
          signature,
          sdkKey: ZSDK_KEY,
          meetingNumber,
          userName,
          passWord: passcode,
          success: () => {
            setStatus('joined');

            ZoomMtg.inMeetingServiceListener('onUserJoin', (payload) => {
              const items = (payload?.userList && Array.isArray(payload.userList)) ? payload.userList : [payload];
              const roster = items.filter(Boolean).map(u => ({
                participantUUID: u.participantUUID || String(u.userId || ''),
                displayName: u.userName || 'Participant'
              }));
              if (roster.length) {
                hubRef.current?.send(JSON.stringify({ type:'set_meeting', meetingId: meetingIdForHub, roster }));
              }
            });

            ZoomMtg.inMeetingServiceListener('onUserLeave', () => {
              // no-op for demo; presence will refresh on next join
            });
          },
          error: (err) => { console.error('Zoom join error', err); setStatus('error'); }
        });
      },
      error: (err) => { console.error('Zoom init error', err); setStatus('error'); }
    });
  } catch (e) {
    console.error('joinZoom failed:', e);
    setStatus('error');
    alert(`Join failed: ${e.message}`);
  }
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
            <label>Passcode <input value={passcode} onChange={e=>setPW(e.target.value)} placeholder="pass" /></label>
          </div>
          <div className="row mt">
            <label>Your Display Name <input value={userName} onChange={e=>setName(e.target.value)} /></label>
            <label>Hub Meeting ID <input value={meetingIdForHub} onChange={e=>setHubMtg(e.target.value)} placeholder="mtg-123" /></label>
          </div>
          <div className="row mt">
            <button className="btn primary" onClick={joinZoom}>Join Zoom & Bridge</button>
          </div>
          <div className="small muted mt">
            Embeds Zoom Meeting SDK and forwards participant joins to TroofAI Hub by participant UUID/userId.
          </div>
        </div>

        {/* Zoom injects its UI here */}
        <div id="zmmtg-root"></div>
      </main>
    </div>
  );
}