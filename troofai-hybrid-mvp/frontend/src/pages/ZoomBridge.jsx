import React, { useRef, useState } from 'react';
import { ZoomMtg } from '@zoom/meetingsdk';

const HUB_URL  = import.meta.env.VITE_HUB_URL || 'ws://127.0.0.1:8080';
const AUTH_URL = import.meta.env.VITE_ZOOM_AUTH_URL || 'http://127.0.0.1:8888/zoom-auth';
const ZSDK_KEY = import.meta.env.VITE_ZOOM_SDK_KEY || '';

export default function ZoomBridge() {
  const [status, setStatus] = useState('idle');
  const [meetingNumber, setMN] = useState(import.meta.env.VITE_ZOOM_MEETING_NUMBER || '');
  const [passcode, setPW] = useState(import.meta.env.VITE_ZOOM_PASSCODE || '');
  const [userName, setName] = useState('TroofAI Demo');
  const [meetingIdForHub, setHubMtg] = useState('mtg-123');

  const wsRef = useRef(null);

  function ensureHub() {
    if (wsRef.current && wsRef.current.readyState === 1) return;
    const ws = new WebSocket(HUB_URL);
    ws.onopen = () => ws.send(JSON.stringify({ type:'role', role:'verifier' }));
    wsRef.current = ws;
  }

  function pushRoster(names) {
    const roster = names
      .map(n => (n || '').trim())
      .filter(Boolean)
      .map(displayName => ({ displayName }));
    wsRef.current?.send(JSON.stringify({ type:'set_meeting', meetingId: meetingIdForHub, roster }));
  }

  async function joinZoom() {
    if (!ZSDK_KEY) { alert('Missing VITE_ZOOM_SDK_KEY'); return; }
    if (!meetingNumber) { alert('Set Zoom meeting number'); return; }

    ensureHub();
    setStatus('preparing');
    ZoomMtg.setZoomJSLib('https://source.zoom.us/4.0.7/lib', '/av');
    ZoomMtg.preLoadWasm(); ZoomMtg.prepareWebSDK();
    ZoomMtg.i18n.load('en-US'); ZoomMtg.i18n.reload('en-US');

    const signature = await fetch(`${AUTH_URL}?mn=${encodeURIComponent(meetingNumber)}&role=0`).then(r => r.text());

    setStatus('joining');
    ZoomMtg.init({
      leaveUrl: window.location.origin,
      success: () => {
        ZoomMtg.join({
          signature, sdkKey: ZSDK_KEY, meetingNumber, userName, passWord: passcode,
          success: () => {
            setStatus('joined');

            // As users join, push their displayName (SDK exposes userName, not emails)
            ZoomMtg.inMeetingServiceListener('onUserJoin', (payload) => {
              const items = (payload.userList && Array.isArray(payload.userList)) ? payload.userList : [payload];
              const names = items.map(u => u.userName || 'Participant');
              pushRoster(names);
            });

            // On your own join, at least push your display name so Companion can bind
            pushRoster([userName]);
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
            <label>Hub Meeting ID <input value={meetingIdForHub} onChange={e=>setHubMtg(e.target.value)} placeholder="mtg-123" /></label>
          </div>
          <div className="row mt">
            <button className="btn primary" onClick={joinZoom}>Join Zoom & Bridge</button>
          </div>
          <div className="small muted mt">
            SDKs don’t expose other attendees’ emails on Basic plans. We bind by <b>display name</b> for the demo and still auto-challenge devices.
          </div>
        </div>

        <div id="zmmtg-root"></div>
      </main>
    </div>
  );
}